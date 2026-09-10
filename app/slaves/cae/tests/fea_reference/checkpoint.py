"""운전 수렴 검증만을 위한 전체 상태 저장/분기. Runtime의 재시작 API가 아니다.

실제 sim.run이 결과를 commit한 뒤 수렴한 구간 경계만 저장한다. 분기의 첫
호출은 저장된 물리 상태에서 interface/예측 파형만 구성한다. 시간 적분이나
물리 상태 재초기화를 하지 않으며, 이후에는 원래 Catalog simulate를 실행한다.
체크포인트 pickle은 이 도구가 만든 신뢰 가능한 로컬 파일에만 사용한다.
"""

import argparse
import asyncio
import hashlib
import json
import platform
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import scipy

from app.kernel.api import SolverResult, StatePatch
from app.kernel.coordinator.commit import commit_result
from app.kernel.coordinator.plan import RunPlan, detached
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import PicklePayloadCodec, SolverExecutionTransaction
from app.solvers.structural_mechanics.coupling import clock_tolerance, predict_motion
from app.solvers.structural_mechanics.domain import (
    build_model,
    parameter,
    update_fingerprint,
)
from app.solvers.structural_mechanics.outputs import build_outputs, configure_history
from app.solvers.structural_mechanics.state import read_state

TASK_NAMES = {"structural_mechanics": "structure", "wind_turbine_control": "control", "aerodynamic_loading": "aerodynamics", "hydrodynamic_loading": "hydrodynamics"}
TIME_CHANGES = ("dt", "windowSize", "duration")


def fingerprint(value):
    digest = hashlib.sha256()
    update_fingerprint(digest, value)
    return digest.hexdigest()


def source_hashes():
    root = Path(__file__).resolve().parents[2] / "app/solvers"
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for package in TASK_NAMES for path in sorted((root / package).glob("*.py"))}


def time_parameters(measurement):
    rules = measurement["experiment"]["simulationProgram"]["tasks"]["structure"]["config"]["initializations"]
    return next(rule["parameters"] for rule in rules if rule["methodId"] == "fea.time")


def structural_model(plan):
    spec = plan.task_specs["structure"]
    model = build_model(SimpleNamespace(config=detached(spec.task["config"]), world=plan.world(spec)))
    configure_history(model, spec.task["config"]["outputs"])
    return model


def load_checkpoint(path):
    """해시가 일치하는 이 도구의 로컬 파일을 읽는다. 수치값은 그대로 복원한다."""
    path = Path(path)
    manifest = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    encoded = path.read_bytes()
    if manifest.get("format") != "fea-verification-checkpoint-v1" or hashlib.sha256(encoded).hexdigest() != manifest["payloadSha256"]:
        raise ValueError("verification checkpoint format or payload checksum does not match")
    payload = PicklePayloadCodec().decode(encoded)
    if fingerprint(payload["state"]) != manifest["stateSha256"] or fingerprint(payload["measurement"]) != manifest["measurementSha256"]:
        raise ValueError("verification checkpoint state or Measurement checksum does not match")
    return payload, manifest


def prepare_branch(run, payload, manifest):
    """명시적 시간 설정 차이만 허용한 뒤 복사본의 identity 네 개만 바꾼다.

    Solver의 재시작 거절 조건은 그대로 둔다. 물리 입력을 바꾼 상태에 새 hash를
    붙이는 편법이 되지 않도록 전체 Measurement와 소스/계약을 먼저 비교한다.
    """
    if source_hashes() != manifest["solverSourceSha256"]:
        raise ValueError("checkpoint solver source hashes differ")
    runtime = {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__}
    if runtime != manifest["runtime"]:
        raise ValueError("checkpoint numerical runtime versions differ")
    descriptors = {name: detached(spec.descriptor) for name, spec in run.plan.task_specs.items()}
    if fingerprint(descriptors) != manifest["descriptorSha256"]:
        raise ValueError("checkpoint Catalog descriptors differ")
    original, candidate = payload["measurement"], deepcopy(run.measurement)
    old_time, new_time = time_parameters(original), time_parameters(candidate)
    changes = {}
    for name in TIME_CHANGES:
        old, new = parameter(old_time[name]), parameter(new_time[name])
        if not np.isfinite(new) or new <= 0:
            raise ValueError("branch time settings must be finite and positive")
        changes[name] = {"saved": old, "branch": new}
        # value만 원복한다. dtype, axes 등 계약까지 바꾸는 것은 허용하지 않는다.
        new_time[name]["value"] = deepcopy(old_time[name]["value"])
    old_vars, new_vars = original["experiment"]["variables"], candidate["experiment"]["variables"]
    for name in (*TIME_CHANGES, "windows"):
        if (name in old_vars) != (name in new_vars):
            raise ValueError("branch loop Vars must preserve the original keys")
        if name in old_vars:
            new_vars[name] = deepcopy(old_vars[name])
    if fingerprint(candidate) != fingerprint(original):
        raise ValueError("branch changes physical inputs or fields outside the time-setting whitelist")
    actual_vars = run.measurement["experiment"]["variables"]
    for name in TIME_CHANGES:
        if name in actual_vars and actual_vars[name] != changes[name]["branch"]:
            raise ValueError("branch time parameters and loop Vars must agree")
    program = original["experiment"]["simulationProgram"]
    original_plan = RunPlan.prepare(original, program["tasks"], program["recordedData"])
    before, after = structural_model(original_plan), structural_model(run.plan)
    state = deepcopy(payload["state"])
    start = float(manifest["time"])
    if changes["duration"]["branch"] <= start:
        raise ValueError("branch absolute duration must be after the checkpoint time")
    for namespace, task in TASK_NAMES.items():
        saved = state[namespace][task]
        if saved["modelIdentity"] != before.identity or not np.isclose(saved["time"], start, atol=1e-10, rtol=0):
            raise ValueError("all four accepted Task states must share this model and checkpoint time")
        saved["modelIdentity"] = after.identity
    # read_state의 절점 선택/배열 계약도 정상 경로로 검사한다. 좌표, 속도,
    # 가속도, unwrapped 상대각, 재료/제어/유입 이력은 전혀 수정하지 않는다.
    solution = read_state(after, state["structural_mechanics"]["structure"])
    restored = deepcopy(state)
    for namespace, task in TASK_NAMES.items():
        restored[namespace][task]["modelIdentity"] = before.identity
    if fingerprint(restored) != manifest["stateSha256"]:
        raise ValueError("branch bootstrap changed a physical checkpoint value")
    provenance = {"kind": "diagnostic-checkpoint-bootstrap", "physicalSteps": 0, "time": start,
                  "checkpointPayloadSha256": manifest["payloadSha256"], "unchangedPhysicalStateSha256": manifest["stateSha256"],
                  "savedModelIdentity": before.identity, "branchModelIdentity": after.identity, "timeChanges": changes,
                  "loopDuration": changes["duration"]["branch"] - start,
                  "interpretation": "conditional convergence over a common accepted initial state; excludes warmup convergence"}
    # 저장 시각의 0.1-1ulp 같은 꼬리가 원래 ceil 반복문에 한 구간을 더
    # 만들지 않도록 반복 횟수만 정수화한다. 실제 상태/종료 시각은 바꾸지 않는다.
    window = changes["windowSize"]["branch"]
    nearest = round(provenance["loopDuration"] / window)
    allowance = clock_tolerance({"duration": max(changes["duration"].values()), "dt": min(changes["dt"].values()), "windowSize": min(changes["windowSize"].values())})
    count = nearest if abs(provenance["loopDuration"] - nearest * window) <= allowance else int(np.ceil(provenance["loopDuration"] / window))
    provenance["remainingDuration"] = provenance["loopDuration"]
    provenance["loopWindowCount"] = max(count, 1)
    provenance["loopDuration"] = float(np.nextafter(provenance["loopWindowCount"] * window, 0.))
    return state, after, solution, provenance


class CheckpointSimulation:
    """원래 simulate의 호출/해제/ACK 순서를 보존하는 검증용 관찰자."""

    def __init__(self, sim, directory, times, resume=None):
        self.sim = sim
        self.directory = Path(directory)
        self.pending = {float(value) for value in times}
        if any(not np.isfinite(value) or value <= 0 for value in self.pending):
            raise ValueError("checkpoint times must be finite positive accepted boundaries")
        self.sources = source_hashes()
        self.harness_source = Path(__file__).read_bytes()
        self.clock_allowance = clock_tolerance({name: parameter(value) for name, value in time_parameters(sim._run.measurement).items()})
        self.bootstrap = None
        self.provenance = None
        if resume is not None:
            payload, manifest = load_checkpoint(resume)
            state, model, solution, self.provenance = prepare_branch(sim._run, payload, manifest)
            spec = sim._run.plan.task_specs["structure"]
            settings = {name: parameter(value) for name, value in time_parameters(sim._run.measurement).items()}
            motion = predict_motion(model, solution, settings)
            artifacts = build_outputs(spec.task["config"], spec.descriptor, model, solution, motion, history_complete=False)
            # 초기 호출은 진단용 복원이다. ABI 결과 검증/원자적 commit 경로를
            # 재사용하지만 물리 Solver가 한 단계를 계산했다고 기록하지 않는다.
            transaction = SolverExecutionTransaction(SolverResult(StatePatch().replace(state), artifacts, {"time": solution.time, "couplingConverged": True}))
            output_state, handles = commit_result(transaction, spec, sim._states.empty, resources=sim._resources, states=sim._states, artifacts=sim._artifacts)
            self.bootstrap = {"state": output_state, "artifacts": handles, "observations": {"time": solution.time, "couplingConverged": True}}
            self.directory.mkdir(parents=True, exist_ok=True)
            (self.directory / "branch-provenance.json").write_text(json.dumps(self.provenance, ensure_ascii=False, indent=2), encoding="utf-8")

    async def run(self, task, options=None, *, state=None, inputs=None):
        name = self.sim._run.plan.resolve(task).name
        if self.bootstrap is not None:
            if name != "structure" or options is not None or state is not None or inputs is not None:
                raise ValueError("checkpoint bootstrap requires the original initial structural call")
            result, self.bootstrap = self.bootstrap, None
            self.sim._run.trace.append({"task": "structure", "status": "diagnostic-checkpoint-bootstrap", **self.provenance})
            return result
        result = await self.sim.run(task, options, state=state, inputs=inputs)
        if name == "structure" and result["observations"]["couplingConverged"] and result["observations"]["time"] > 0:
            time = float(result["observations"]["time"])
            for target in sorted(self.pending):
                if time > target + self.clock_allowance:
                    raise ValueError(f"checkpoint time {target} is not an accepted coupling boundary")
                if abs(time - target) <= self.clock_allowance:
                    self.save(result, inputs or (options or {}).get("inputs", {}))
                    self.pending.remove(target)
        return result

    def save(self, result, inputs):
        """모든 상태/배열을 복사한 뒤 저장한다. 거절된 trial은 여기 오지 않는다."""
        if not result["observations"]["couplingConverged"] or result["observations"]["time"] <= 0:
            raise ValueError("only an accepted physical window can become a checkpoint")
        if source_hashes() != self.sources:
            raise ValueError("solver sources changed while a checkpoint was being produced")
        run = self.sim._run
        state = result["state"].to_mutable(copy_arrays=True)
        time = float(result["observations"]["time"])
        identities = set()
        for namespace, task in TASK_NAMES.items():
            saved = state[namespace][task]
            if not np.isclose(saved["time"], time, atol=1e-10, rtol=0):
                raise ValueError("cannot save a partially advanced coupled checkpoint")
            identities.add(saved["modelIdentity"])
        if len(identities) != 1:
            raise ValueError("accepted coupled Task states have different model identities")
        artifacts = {name: self.sim._artifacts.materialize(handle, copy_arrays=True) for name, handle in result["artifacts"].items()}
        accepted_inputs = {name: [self.sim._artifacts.materialize(handle, copy_arrays=True) for handle in handles] if isinstance(handles, (list, tuple)) else self.sim._artifacts.materialize(handles, copy_arrays=True) for name, handles in inputs.items()}
        payload = {"state": state, "measurement": deepcopy(run.measurement), "artifacts": artifacts, "acceptedInputs": accepted_inputs}
        encoded = PicklePayloadCodec().encode(payload)
        manifest = {"format": "fea-verification-checkpoint-v1", "time": time, "stateRevision": result["state"].revision,
                    "observations": dict(result["observations"]), "modelIdentity": next(iter(identities)),
                    "payloadSha256": hashlib.sha256(encoded).hexdigest(), "stateSha256": fingerprint(state),
                    "measurementSha256": fingerprint(run.measurement), "solverSourceSha256": self.sources,
                    "descriptorSha256": fingerprint({name: detached(spec.descriptor) for name, spec in run.plan.task_specs.items()}),
                    "runtime": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__},
                    "sourceRunId": run.run_id, "bootstrap": self.provenance,
                    "checkpointHarnessSha256": hashlib.sha256(self.harness_source).hexdigest(),
                    "artifactProvenance": {name: {"producerTask": handle.provenance.producer_task, "solverName": handle.provenance.solver_name, "solverVersion": handle.provenance.solver_version, "outputName": handle.provenance.output_name, "artifactType": handle.artifact_type, "stateRevision": handle.produced_state_revision} for name, handle in result["artifacts"].items()}}
        manifest["acceptedInputProvenance"] = {}
        for name, handles in inputs.items():
            items = handles if isinstance(handles, (list, tuple)) else [handles]
            provenance = [{"producerTask": handle.provenance.producer_task, "solverName": handle.provenance.solver_name, "solverVersion": handle.provenance.solver_version, "outputName": handle.provenance.output_name, "artifactType": handle.artifact_type, "stateRevision": handle.produced_state_revision} for handle in items]
            manifest["acceptedInputProvenance"][name] = provenance if isinstance(handles, (list, tuple)) else provenance[0]
        self.directory.mkdir(parents=True, exist_ok=True)
        harness_path = self.directory / "checkpoint-source.py"
        if harness_path.exists() and harness_path.read_bytes() != self.harness_source:
            raise ValueError("checkpoint directory contains a different verification harness")
        harness_path.write_bytes(self.harness_source)
        path = self.directory / f"checkpoint-{time:013.6f}.pkl"
        if path.exists() or path.with_suffix(".json").exists():
            raise ValueError("a verification checkpoint must not overwrite existing evidence")
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(encoded)
        temporary.replace(path)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path.with_suffix(".json"))

    async def record(self, name, value):
        await self.sim.record(name, value)

    def release(self, value, *, keep=None):
        self.sim.release(value, keep=keep)


def observe_run(run, directory, times=(), resume=None):
    """CaeRun 인스턴스에만 관찰자를 붙인다. Runtime 클래스는 바꾸지 않는다."""
    original = run.simulate

    async def simulate(*, sim, tasks, vars):
        observer = CheckpointSimulation(sim, directory, times, resume)
        loop_vars = dict(vars)
        if observer.provenance is not None:
            # Solver duration은 절대 종료 시각이고, 원래 for문의 횟수는 남은 길이다.
            loop_vars["duration"] = observer.provenance["loopDuration"]
        result = await original(sim=observer, tasks=tasks, vars=loop_vars)
        if observer.pending:
            raise ValueError(f"requested checkpoint times were not reached: {sorted(observer.pending)}")
        return result

    run.simulate = simulate
    return run


if __name__ == "__main__":
    # 기존 benchmark의 촘촘한 실제 표본 관찰/Record ACK를 그대로 사용한다.
    # CLI 진입 파일만 별도이며 Solver와 원래 benchmark 파일은 수정하지 않는다.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import fea_operating_benchmark as benchmark

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--duration", type=float, help="absolute end time, including after resume")
    parser.add_argument("--dt", type=float)
    parser.add_argument("--window", type=float)
    parser.add_argument("--wind", type=float)
    parser.add_argument("--generator-efficiency", type=float, default=.944)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--in-process", action="store_true")
    parser.add_argument("--checkpoint-times", type=float, nargs="*", default=[])
    parser.add_argument("--resume", type=Path)
    args = parser.parse_args()

    def checkpoint_run(**options):
        return observe_run(CaeRun(**options), Path(args.out) / "checkpoints", args.checkpoint_times, args.resume)

    benchmark.CaeRun = checkpoint_run
    asyncio.run(benchmark.benchmark(args))
