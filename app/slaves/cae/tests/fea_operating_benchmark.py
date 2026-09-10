"""Catalog 터빈의 실행 시간/수렴 비교 도구. 데이터나 새 문제 포맷을 정의하지 않는다.

기본은 실제 child 실행이다. --in-process는 수치 프로파일용으로만 child 경계를
생략하며, 동일 ABI 함수/상태 commit/파형 반복/기록 ACK는 그대로 실행한다.
이 모드의 결과를 프로세스 간 전송·취소 검증으로 보고해서는 안 된다.
"""

import argparse
import asyncio
import hashlib
import importlib
import json
import os
import platform
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
import scipy

from app.kernel.coordinator import simulation
from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import SolverExecutionTransaction, SpawnSolverExecutor
from app.kernel.transport import RecordPacket
from app.kernel.transport.tensor import dtype_for


class InProcessExecutor(SpawnSolverExecutor):
    def __init__(self, **options):
        super().__init__(**options)
        self.samples = []

    async def execute_transaction(self, locator, context, **options):
        module, attribute = locator.split(":", 1)
        implementation = getattr(importlib.import_module(module), attribute)
        actual_motion = None
        if context.task_name == "structure":
            from app.solvers.structural_mechanics import coupling
            original_motion = coupling.motion_from_samples

            def capture_motion(model, samples, pitches, iteration):
                nonlocal actual_motion
                motion = original_motion(model, samples, pitches, iteration)
                if iteration > 0:
                    actual_motion = motion
                return motion

            # This observer captures the already-computed waveform. It never
            # changes a solver value, the ABI, trial acceptance, or state commit.
            coupling.motion_from_samples = capture_motion
        try:
            result = await implementation.run(replace(context, progress=options.get("progress")))
        finally:
            if context.task_name == "structure":
                coupling.motion_from_samples = original_motion
        if "couplingResidual" in result.observations:
            print(json.dumps({"task": context.task_name, **result.observations}), flush=True)
        if context.task_name == "structure" and result.observations["couplingConverged"] and result.observations["time"] > 0:
            # Capture every actual sample of the accepted window, not merely
            # its endpoint: .05 s output would alias high support modes above
            # 10 Hz. Rejected trials and the next-window predictor are excluded.
            if actual_motion is None:
                raise ValueError("accepted structural window has no captured actual motion")
            motion = actual_motion
            interface = result.artifacts["interface"].members
            ids = {int(node): index for index, node in enumerate(interface["nodeIds"])}
            rotor = next(rule["parameters"] for rule in context.config["initializations"] if rule["methodId"] == "fea.rotor")
            rotor = {key: value["value"] if hasattr(value, "keys") else value for key, value in rotor.items()}
            hub, root, tip = (ids[int(node)] for node in (rotor["hubNode"], rotor["bladeRootNodes"][0], rotor["bladeNodeIds"][0][-1]))
            for sample, sample_time in enumerate(motion["times"]):
                if self.samples and sample_time <= self.samples[-1]["times"] + 1e-12:
                    continue
                positions, orientations = motion["positions"][sample], motion["orientations"][sample]
                root_rotation = orientations[root] @ interface["referenceOrientations"][root].T
                relative_tip = root_rotation.T @ (positions[tip] - positions[root]) - (interface["referencePositions"][tip] - interface["referencePositions"][root])
                row = {"times": float(sample_time), "rotorSpeed": float(motion["rotorSpeed"][sample]), "generatorSpeed": float(motion["generatorSpeed"][sample]), "pitch": float(motion["pitch"][sample]), "bladeTipDeflectionX": float(relative_tip[0]), "bladeTipDeflectionY": float(relative_tip[1]), "bladeTipDeflectionZ": float(relative_tip[2])}
                if "control" in context.inputs:
                    control = context.inputs["control"].value.members
                    row["generatorTorque"] = float(np.interp(sample_time, control["times"], control["generatorTorque"]))
                    row["mechanicalPower"] = row["generatorTorque"] * row["generatorSpeed"]
                axis = orientations[hub] @ interface["referenceOrientations"][hub].T @ np.asarray(rotor["axis"])
                for load in context.inputs.get("loads", ()):
                    values = load.value.members
                    if not np.allclose(values["times"], motion["times"], rtol=0., atol=1e-10):
                        raise ValueError("comparison loads must share the accepted motion time coordinates")
                    if load.solver_name == "aerodynamic-loading":
                        force, moment = values["forces"][sample], values["moments"][sample]
                        row["aerodynamicThrust"] = float(force.sum(axis=0) @ axis)
                        row["aerodynamicTorque"] = float((moment + np.cross(positions - positions[hub], force)).sum(axis=0) @ axis)
                    if load.solver_name == "hydrodynamic-loading":
                        # HydroDyn reports the complete force on the moving body.
                        # Restore the body-acceleration term only for comparison.
                        total = values["forces"][sample] - np.einsum("nij,nj->ni", values["addedMass"], motion["accelerations"][sample])
                        row["hydrodynamicForceX"] = float(total[:, 0].sum())
                self.samples.append(row)
        return SolverExecutionTransaction(result)


async def benchmark(args):
    artifact = Path(args.artifact).resolve()
    manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
    item = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
    measurement = item["measurement"]
    experiment = measurement["experiment"]
    tasks = experiment["simulationProgram"]["tasks"]
    settings = next(rule["parameters"] for rule in tasks["structure"]["config"]["initializations"] if rule["methodId"] == "fea.time")
    for key, value in (("dt", args.dt), ("windowSize", args.window), ("duration", args.duration)):
        if value is not None:
            settings[key]["value"] = value
            if key in experiment["variables"]:
                experiment["variables"][key] = value
    if "windows" in experiment["variables"]:
        experiment["variables"]["windows"] = int(np.ceil(settings["duration"]["value"] / settings["windowSize"]["value"]))
    if args.wind is not None:
        velocities = tasks["aerodynamics"]["config"]["parameters"]["windVelocities"]
        velocities["value"] = [[args.wind, 0., 0.]] * 4
        if "windSpeed" in experiment["variables"]:
            experiment["variables"]["windSpeed"] = args.wind
            experiment["variables"]["windDelta"] = 0.
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=False)
    solver_root = Path(__file__).resolve().parents[1] / "app/solvers"
    source_paths = sorted(path for package in ("structural_mechanics", "aerodynamic_loading", "hydrodynamic_loading", "wind_turbine_control")
                          for path in (solver_root / package).rglob("*.py"))
    source_hashes = {}
    for path in source_paths:
        content = path.read_bytes()
        source_hashes[str(path.relative_to(solver_root))] = hashlib.sha256(content).hexdigest()
        saved_source = output / "solver-source" / path.relative_to(solver_root)
        saved_source.parent.mkdir(parents=True, exist_ok=True)
        saved_source.write_bytes(content)
    (output / "benchmark-source.py").write_bytes(Path(__file__).read_bytes())
    # 변경은 실행 전에 새 Measurement에 한 번 적용하며, sim.run 중 override하지 않는다.
    (output / "measurement.json").write_text(json.dumps(measurement, ensure_ascii=False), encoding="utf-8")
    if args.in_process:
        simulation.SpawnSolverExecutor = InProcessExecutor
    run = CaeRun(measurement=measurement, max_run_seconds=args.timeout, job_id="fea-numerical-benchmark")
    start = time.perf_counter()
    run.start()
    recorded = {}
    status = {"kind": "failed", "message": "interrupted"}
    try:
        while True:
            packet = await run.queue.get()
            if not isinstance(packet, RecordPacket):
                if packet["kind"] in {"complete", "failed"}:
                    status = packet
                    break
                continue
            attachments = {item.id: item.data for item in packet.attachments}
            pending = [(packet.name, run.schemas[packet.name], packet.value)]
            while pending:
                name, schema, value = pending.pop()
                if "dtype" not in schema:
                    pending.extend((f"{name}.{member}", child_schema, value[member]) for member, child_schema in schema.items())
                    continue
                storage = value["storage"]
                if storage["kind"] == "inline":
                    array = np.asarray(storage["value"], dtype=dtype_for(schema["dtype"]))
                else:
                    raw = b"".join(attachments[identifier] for identifier in storage["ids"])
                    array = np.frombuffer(raw, dtype=dtype_for(schema["dtype"]))
                recorded[name] = array.reshape(value["shape"]).copy()
            run.pending = packet
            run.acknowledge(packet.sequence)
        await run.task
    finally:
        executor = None if run.simulation_api is None else run.simulation_api._executor
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
        elapsed = time.perf_counter() - start
        evidence = {"status": status, "wallSeconds": elapsed, "execution": "in-process numerical benchmark" if args.in_process else "spawn children", "inputBuildManifest": manifest, "measurementSha256": hashlib.sha256((output / "measurement.json").read_bytes()).hexdigest(), "overrides": {key: getattr(args, key) for key in ("dt", "window", "duration", "wind", "generator_efficiency")}, "recordBytes": run.recorded_bytes, "trace": run.trace, "schemas": run.schemas}
        final_hashes = {str(path.relative_to(solver_root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}
        evidence.update(solverSourceSha256=source_hashes, sourceFilesChangedDuringRun=final_hashes != source_hashes,
                        runtime={"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
                                 "OPENBLAS_NUM_THREADS": os.environ.get("OPENBLAS_NUM_THREADS"),
                                 "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS")})
        (output / "report.json").write_text(json.dumps(detached(evidence), ensure_ascii=False, indent=2), encoding="utf-8")
        np.savez_compressed(output / "records.npz", **recorded)
        channels = {name.removeprefix("history."): value for name, value in recorded.items() if name.startswith("history.")}
        if channels:
            channels["time"] = channels["times"]
            np.savez_compressed(output / "native_si.npz", **channels)
        if args.in_process and executor is not None and executor.samples:
            samples = {name: np.asarray([row[name] for row in executor.samples]) for name in executor.samples[0]}
            if "mechanicalPower" in samples:
                samples["electricalPower"] = args.generator_efficiency * samples["mechanicalPower"]
            if channels:
                # Find the tower top from the example's actual detail-transfer
                # reference point, then locate that ID in the selected history.
                initializations = tasks["structure"]["config"]["initializations"]
                nodes = next(rule["parameters"] for rule in initializations if rule["methodId"] == "fea.nodes")
                node_ids = np.asarray(nodes["nodeIds"]["value"])
                points = np.asarray(nodes["positions"]["value"])
                transfer = next(rule["parameters"] for rule in tasks["towerDetail"]["config"]["boundaryConditions"] if rule["methodId"] == "fea.resultant-transfer")
                top = np.flatnonzero(np.all(np.isclose(points, transfer["referencePoint"]["value"], atol=1e-10), axis=1))
                if len(top) != 1:
                    raise ValueError("comparison requires a unique node at the declared tower top")
                top_history = np.flatnonzero(channels["nodeIds"] == node_ids[top[0]])
                if len(top_history) != 1:
                    raise ValueError("comparison requires the tower-top node in selected history")
                samples["towerDisplacementX"] = np.interp(samples["times"], channels["times"], channels["displacement"][:, top_history[0], 0])
                fixed = [rule["parameters"]["nodeIds"]["value"] for rule in tasks["structure"]["config"]["boundaryConditions"] if rule["methodId"] == "fea.fixed"]
                fixed_ids = np.unique(np.concatenate(fixed))
                support = np.flatnonzero(np.isin(channels["nodeIds"], fixed_ids))
                if len(support) != len(fixed_ids):
                    raise ValueError("comparison requires every support node in selected history")
                hydro = tasks["hydrodynamics"]["config"]["parameters"]
                mudline = np.asarray([0., 0., -float(hydro["waterDepth"]["value"])])
                point_lookup = {int(node): point for node, point in zip(node_ids, points, strict=True)}
                arms = np.asarray([point_lookup[int(node)] - mudline for node in channels["nodeIds"][support]])
                support_force = channels["reaction"][:, support]
                support_moment = channels["reactionMoment"][:, support] + np.cross(arms, support_force)
                samples["foundationForceX"] = np.interp(samples["times"], channels["times"], support_force[:, :, 0].sum(axis=1))
                samples["foundationMomentY"] = np.interp(samples["times"], channels["times"], support_moment[:, :, 1].sum(axis=1))
                samples["waveElevation"] = (np.asarray(hydro["waveAmplitudes"]["value"]) * np.cos(-samples["times"][:, None] * (2 * np.pi / np.asarray(hydro["wavePeriods"]["value"])) + np.asarray(hydro["wavePhases"]["value"]))).sum(axis=1)
            np.savez_compressed(output / "comparison_si.npz", **samples)
    print(json.dumps({"status": status["kind"], "wallSeconds": elapsed, "out": str(output)}), flush=True)
    if status["kind"] != "complete":
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--dt", type=float)
    parser.add_argument("--window", type=float)
    parser.add_argument("--wind", type=float)
    parser.add_argument("--generator-efficiency", type=float, default=.944, help="reference ElastoDyn/ServoDyn GenEff / 100; used for comparison conversion only")
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--in-process", action="store_true")
    asyncio.run(benchmark(parser.parse_args()))
