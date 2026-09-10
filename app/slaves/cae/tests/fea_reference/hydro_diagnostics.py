"""초기 수력 차이를 외력과 부가질량 반력으로 나누는 독립 진단입니다.

reference는 기존에 준비한 OC3 입력을 복사하고 출력 채널/명시한 진단 조건만
바꿉니다. native는 공개 ABI 실행을 계측하여 수렴한 전체 절점 운동을 저장합니다.
기본 Catalog 모델이나 solver 계산식을 수정하지 않습니다. 축방향 연결 옵션은
ElastoDyn 타워의 자유도 차이를 조사하는 별도 모델이며 기본 FEA 결과가 아닙니다.
"""

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from openfast import CASE_FILE, EXECUTABLE_HASHES, REPOSITORY

sys.path.insert(0, str(REPOSITORY / "app/slaves/cae"))
sys.path.insert(0, str(REPOSITORY / "app/slaves/cae/tests"))
from compare import read_reference

from app.solvers.hydrodynamic_loading.formulation import hydrodynamic_response


def run_reference(args):
    source = args.directory / "model" / args.case
    destination = args.directory / "model" / args.name
    destination.mkdir(exist_ok=False)
    for path in source.iterdir():
        if path.suffix in (".dat", ".fst"):
            shutil.copyfile(path, destination / path.name)
    changes = {CASE_FILE: {"TMax": args.duration}}
    if args.dt is not None:
        changes[CASE_FILE].update(DT=args.dt, DT_Out=args.dt)
    subdyn = next(destination.glob("*_SubDyn.dat"))
    if args.internal_modes is not None:
        changes[subdyn.name] = {"Nmodes": args.internal_modes}
    if args.gravity is not None:
        changes[CASE_FILE]["Gravity"] = args.gravity
    # g=0에서는 파랑 분산식 자체가 정의되지 않는다. 중력 비교 양쪽에서
    # --no-wave를 사용해야 파랑의 유무를 중력 효과로 오인하지 않는다.
    if args.no_wave or args.gravity == 0:
        changes["SeaState.dat"] = {"WaveMod": 0, "CurrSSDir": 0}
    for filename, settings in changes.items():
        path = destination / filename
        content = path.read_text(encoding="utf-8")
        for label, value in settings.items():
            content, count = re.subn(
                rf"^\s*\S+\s+{label}\s", f"{value} {label} ", content, flags=re.MULTILINE
            )
            if count != 1:
                raise ValueError(f"Expected exactly one {label} in {path}")
        path.write_text(content, encoding="utf-8")
    content = subdyn.read_text(encoding="utf-8")
    divisions = int(re.search(r"^\s*(\d+)\s+NDiv\s", content, re.MULTILINE)[1])
    members = int(re.search(r"^\s*(\d+)\s+NMembers\s", content, re.MULTILINE)[1])
    if members != 3 or divisions != 3:
        raise ValueError("This diagnostic expects the pinned OC3 three-member mesh")
    start = content.index("------------------------- MEMBER OUTPUT LIST")
    end = content.index("------------------------- SSOutList", start)
    content = content[:start] + (
        "------------------------- MEMBER OUTPUT LIST\n3 NMOutputs\n"
        "MemberID NOutCnt NodeCnt\n(-) (-) (-)\n"
        "1 4 1 2 3 4\n2 4 1 2 3 4\n3 4 1 2 3 4\n"
    ) + content[end:]
    channels = [f"M{member}N{node}{quantity}"
                for member in range(1, 4) for node in range(1, 5)
                for quantity in ("TDxss", "TDyss", "TDzss", "TAxe", "TAye", "TAze")]
    content = content.replace("END of output channels", "\n".join(
        f'"{channel}"' for channel in channels) + "\nEND of output channels")
    subdyn.write_text(content, encoding="utf-8")
    elastodyn = next(destination.glob("*_ElastoDyn.dat"))
    content = elastodyn.read_text(encoding="utf-8")
    end = content.index("END", content.index("OutList"))
    channels = [f"Ptfm{kind}{axis}i" for kind in ("TA", "RA", "TV", "RV")
                for axis in ("x", "y", "z")]
    content = content[:end] + "\n".join(f'"{channel}"' for channel in channels) + "\n" + content[end:]
    elastodyn.write_text(content, encoding="utf-8")
    executable = args.directory / "bin/OpenFAST_Double_Release.exe"
    if hashlib.sha256(executable.read_bytes()).hexdigest() != EXECUTABLE_HASHES[executable.name]:
        raise ValueError("OpenFAST executable checksum differs from the pinned release")
    provenance = {"sourceCase": str(source), "changes": changes,
                  "addedOutputs": "all SubDyn member node displacements/accelerations; platform kinematics",
                  "inputHashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in destination.iterdir() if p.suffix in (".dat", ".fst")}}
    with (destination / "stdout.log").open("w", encoding="utf-8") as output:
        result = subprocess.run([str(executable), CASE_FILE], cwd=destination,
                                stdout=output, stderr=subprocess.STDOUT, check=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    normal = "OpenFAST terminated normally." in (destination / "stdout.log").read_text(encoding="utf-8")
    provenance.update(exitCode=result.returncode, normalTermination=normal)
    (destination / "diagnostic_provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    if result.returncode or not normal:
        raise RuntimeError(f"Diagnostic failed; inspect {destination / 'stdout.log'}")
    print(destination)


def run_native(args):
    import fea_operating_benchmark as benchmark

    from app.solvers.structural_mechanics import coupling

    original_motion = coupling.motion_from_samples
    original_execute = benchmark.InProcessExecutor.execute_transaction
    actual_motion = None

    def capture_motion(model, samples, pitches, iteration):
        nonlocal actual_motion
        motion = original_motion(model, samples, pitches, iteration)
        if iteration > 0:
            actual_motion = motion
        return motion

    async def capture(self, locator, context, **options):
        if context.task_name == "structure" and args.tie_tower_axial:
            config = benchmark.detached(context.config)
            master, *slaves = args.tie_tower_axial
            for slave in slaves:
                config["initializations"].append({"methodId": "fea.rigid-link", "target": [],
                                                  "parameters": {"master": master, "slave": slave, "components": [2]}})
            context = benchmark.replace(context, config=config)
            (args.out / "diagnostic_structural_config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        transaction = await original_execute(self, locator, context, **options)
        result = transaction.value
        if context.task_name == "structure" and result.observations["couplingConverged"] and result.observations["time"] > 0:
            arrays = {"actual_" + key: np.asarray(value) for key, value in actual_motion.items() if key != "modelIdentity"}
            for load in context.inputs.get("loads", ()):
                if load.solver_name == "hydrodynamic-loading":
                    arrays.update({"hydro_" + key: np.asarray(value) for key, value in load.value.members.items() if key != "modelIdentity"})
            for operation in result.state_patch.operations:
                if operation.path == ("structural_mechanics", "structure"):
                    arrays.update({"state_" + key: np.asarray(value) for key, value in operation.value.items()
                                   if key in ("time", "displacement", "velocity", "acceleration", "orientations", "reaction")})
            np.savez_compressed(args.out / f"motion_{result.observations['time']:.6f}.npz", **arrays)
        return transaction

    coupling.motion_from_samples = capture_motion
    benchmark.InProcessExecutor.execute_transaction = capture
    settings = argparse.Namespace(artifact=str(args.artifact), out=str(args.out), duration=args.duration,
                                  dt=args.dt, window=None, wind=None, generator_efficiency=.944,
                                  timeout=7200, in_process=True)
    try:
        asyncio.run(benchmark.benchmark(settings))
    finally:
        coupling.motion_from_samples = original_motion
        benchmark.InProcessExecutor.execute_transaction = original_execute
    (args.out / "diagnostic_provenance.json").write_text(json.dumps({
        "purpose": "all-node converged motion capture; optional axial-only tower model diagnostic",
        "tieTowerAxialNodeIds": args.tie_tower_axial,
        "inProcess": True, "builtArtifact": str(args.artifact),
    }, indent=2), encoding="utf-8")


def replay(args):
    raw, _, reference_hash = read_reference(args.reference_case)
    content = next(args.reference_case.glob("*.SD.sum.yaml")).read_text(encoding="utf-8")
    lines = content[content.index("#Direction Cosine Matrices"):].splitlines()[2:5]
    for line in lines:
        matrix = np.asarray([float(value) for value in line.split()[2:]]).reshape(3, 3)
        if not np.array_equal(matrix, np.eye(3)):
            raise ValueError("This OC3 replay requires identity SubDyn member frames")
    item = json.loads(args.built.read_text(encoding="utf-8"))
    config = item["measurement"]["experiment"]["simulationProgram"]["tasks"]["hydrodynamics"]["config"]
    settings = {key: value["value"] if isinstance(value, dict) else value for key, value in config["parameters"].items()}
    original = {key: np.asarray(value["value"] if isinstance(value, dict) else value)
                for key, value in config["initializations"][0]["parameters"].items()}
    # Source member 1: seabed→-10 m, member 2: -10→0 m, each split in three.
    # These coordinates identify the pinned reference mesh, not new solver data.
    depth = float(settings["waterDepth"])
    z = np.concatenate([np.linspace(-depth, -10, 4), np.linspace(-10, 0, 4)[1:]])
    labels = ["M1N1", "M1N2", "M1N3", "M1N4", "M2N2", "M2N3", "M2N4"]
    acceleration = np.array([[raw[label + "TA" + axis + "e"] for axis in "xyz"] for label in labels]).transpose(2, 0, 1)
    displacement = np.array([[raw[label + "TD" + axis + "ss"] for axis in "xyz"] for label in labels]).transpose(2, 0, 1)
    velocity = np.gradient(displacement, raw["Time"], axis=0, edge_order=2)
    members = {key: np.full(len(z)-1, value[0]) for key, value in original.items() if key != "memberNodes"}
    members["indices"] = np.column_stack([np.arange(len(z)-1), np.arange(1, len(z))])
    model = {"modelIdentity": "OpenFAST-SubDyn-motion-replay", "nodeIds": np.arange(len(z), dtype=np.int32),
             "referencePositions": np.column_stack([np.zeros((len(z), 2)), z])}
    loads, _, _ = hydrodynamic_response(settings, members, model, {"times": raw["Time"], "velocities": velocity})
    external = loads["forces"][:, :, 0].sum(axis=1)
    body = np.einsum("nij,tnj->tni", loads["addedMass"], acceleration)[:, :, 0].sum(axis=1)
    total = external - body
    error = total - raw["HydroFxi"]
    report = {"referenceSha256": reference_hash, "builtSha256": hashlib.sha256(args.built.read_bytes()).hexdigest(),
              "rmsDifferenceN": float(np.sqrt(np.mean(error**2))), "maximumDifferenceN": float(np.max(abs(error))),
              "notes": ["Nodal body acceleration is direct SubDyn output; velocity is differentiated displacement.",
                        "Compare original wave/current protocol only; zero-gravity/no-wave diagnostics require matching native settings."]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    np.savez_compressed(args.out.with_suffix(".npz"), times=raw["Time"], external=external,
                        bodyAddedMassForce=body, total=total, reference=raw["HydroFxi"], nodeZ=z,
                        accelerations=acceleration, displacements=displacement)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    reference = actions.add_parser("reference")
    reference.add_argument("--directory", type=Path, required=True)
    reference.add_argument("--case", default="wind08")
    reference.add_argument("--name", required=True, help="new folder name beside the prepared source case")
    reference.add_argument("--duration", type=float, default=.1)
    reference.add_argument("--dt", type=float)
    reference.add_argument("--internal-modes", type=int)
    reference.add_argument("--gravity", type=float)
    reference.add_argument("--no-wave", action="store_true")
    native = actions.add_parser("native")
    native.add_argument("--artifact", type=Path, required=True)
    native.add_argument("--out", type=Path, required=True)
    native.add_argument("--duration", type=float, default=.1)
    native.add_argument("--dt", type=float)
    native.add_argument("--tie-tower-axial", type=int, nargs="+", default=[])
    replay_parser = actions.add_parser("replay")
    replay_parser.add_argument("--reference-case", type=Path, required=True)
    replay_parser.add_argument("--built", type=Path, required=True)
    replay_parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    for key, value in vars(args).items():
        if isinstance(value, Path):
            setattr(args, key, value.resolve())
    if args.action == "reference":
        if Path(args.case).name != args.case or Path(args.name).name != args.name:
            parser.error("case/name must be single folder names")
        run_reference(args)
    elif args.action == "native":
        if len(args.tie_tower_axial) == 1:
            parser.error("an axial tie needs master and slave node IDs")
        run_native(args)
    else:
        replay(args)
