"""정지·무중력·무유체 상태의 OpenFAST 선형화와 native 전체 구조 모드를 비교한다.

운전 중 모드나 피로 검증이 아니다. 현재 Catalog로 만든 built artifact를 읽고,
발전기 축만 나셀에 대해 잠근다. 기본 비교에서는 실제 FEA 타워의 비틀림을 유지한다.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
from openfast import CASE_FILE, RELEASE, REPOSITORY, REVISION
from scipy import linalg


def reference_modes(directory, count):
    path = directory / "model/stationary" / (Path(CASE_FILE).stem + ".1.lin")
    lines = path.read_text(encoding="utf-8").splitlines()
    row = next(i for i, line in enumerate(lines) if line.startswith("A:"))
    size = int(re.match(r"A:\s+(\d+)\s+x", lines[row])[1])
    matrix = np.array([[float(value) for value in line.split()] for line in lines[row+1:row+1+size]])
    values, vectors = linalg.eig(matrix)
    indices = sorted(np.flatnonzero(values.imag > 1e-7), key=lambda i: abs(values[i]))[:count]
    modes = [
        {"frequencyHz": float(abs(values[i]) / (2*np.pi)),
         "dampedFrequencyHz": float(values[i].imag / (2*np.pi)),
         "dampingRatio": float(-values[i].real / abs(values[i]))}
        for i in indices
    ]
    # 상태 이름도 남겨야 정렬 순서가 달라진 모드를 같은 모드로 오인하지 않는다.
    order = lines.index("Order of continuous states:") + 3
    descriptions = [re.split(r"\s+[FT]\s+2\s+", line, maxsplit=1)[-1].strip() for line in lines[order:order+size]]
    return modes, vectors[:, indices], descriptions, hashlib.sha256(path.read_bytes()).hexdigest()


def native_modes(built, catalog, count, tied_tower):
    sys.path.insert(0, str(REPOSITORY / "app/slaves/cae"))
    from app.kernel.api import SolverInvocation
    from app.kernel.catalog import SolverCatalog
    from app.kernel.coordinator import plan as plan_module
    from app.kernel.coordinator.plan import RunPlan, detached
    from app.solvers.structural_mechanics.constraints import constraint_transform
    from app.solvers.structural_mechanics.domain import build_model
    from app.solvers.structural_mechanics.formulation import prepare_matrices

    measurement = json.loads(built.read_text(encoding="utf-8"))["measurement"]
    program = measurement["experiment"]["simulationProgram"]
    plan_module.solver_catalog = SolverCatalog.discover(catalog)
    plan = RunPlan.prepare(measurement, program["tasks"], program["recordedData"])
    spec = plan.task_specs["structure"]
    invocation = SolverInvocation(
        config=detached(spec.task["config"]), state={}, inputs={}, world=plan.world(spec),
        geometry=None, progress=None, descriptor=detached(spec.descriptor), task_name="structure",
    )
    model = build_model(invocation)
    if model.rotor is None:
        raise ValueError("This reference protocol requires the aligned turbine rotor model")
    stiffness, mass, _, _ = prepare_matrices(model)
    # 실제 입력의 중력 합력은 무중력 모드 계산과 별도 감사 값이다.
    # 편심 질량의 절점 모멘트까지 합쳐야 CG의 부호 오류를 잡을 수 있다.
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    gravity_load = np.asarray(mass @ gravity).reshape(-1, 6)
    gravity_force = gravity_load[:, :3].sum(axis=0)
    gravity_moment = (gravity_load[:, 3:] + np.cross(model.points, gravity_load[:, :3])).sum(axis=0)
    generator = model.rotor["generatorNode"]
    # GenDOF=False는 HSS의 상대 회전을 잠근다. global rx=0은 나셀의 흔들림까지
    # 막으므로 같은 경계조건이 아니다. 기존 조인트를 완전한 강체 연결로 바꾼다.
    model.links = [(master, slave, np.arange(6) if slave == generator else components)
                   for master, slave, components in model.links]
    if tied_tower:
        lookup = {int(node): i for i, node in enumerate(model.node_ids)}
        master, *slaves = [lookup[node] for node in tied_tower]
        model.links.extend((master, slave, np.array([5])) for slave in slaves)
    transform = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    values, vectors = linalg.eigh((transform.T @ stiffness @ transform).toarray(), (transform.T @ mass @ transform).toarray())
    positive = np.flatnonzero(values > 1e-5)
    vertical = np.zeros(model.size)
    vertical[2::6] = 1.0
    # phi^T M phi=1 정규화에서 (phi^T M Gamma_z)^2는 수직 유효 모드 질량이다.
    # 모드 벡터의 임의 크기나 m/rad 좌표를 직접 비교하는 오류를 피한다.
    participation = vectors[:, positive].T @ (transform.T @ (mass @ vertical))
    effective_mass = participation**2
    total_mass = float(vertical @ (mass @ vertical))
    order = np.argsort(-effective_mass)[:12]
    audit = {
        "configuredGravity": np.asarray(model.gravity).tolist(),
        "gravityForceN": gravity_force.tolist(),
        "gravityMomentAboutOriginNm": gravity_moment.tolist(),
        "verticalEffectiveMass": [
            {"modeIndex": int(index), "frequencyHz": float(np.sqrt(values[positive[index]]) / (2*np.pi)),
             "effectiveMassKg": float(effective_mass[index]), "fractionOfTotalMass": float(effective_mass[index]/total_mass)}
            for index in order
        ],
    }
    indices = np.flatnonzero(values > 1e-5)[:count]
    modes = [{"frequencyHz": float(np.sqrt(values[i]) / (2*np.pi))} for i in indices]
    physical_modes = np.asarray(transform @ vectors[:, indices]).reshape(len(model.points), 6, len(indices))
    return modes, physical_modes, model.node_ids, audit


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=REPOSITORY / ".work/openfast-reference")
    parser.add_argument("--built", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=REPOSITORY / "app/catalog/caemble_catalog/catalog.sqlite3")
    parser.add_argument("--count", type=int, default=18)
    parser.add_argument("--tie-tower-yaw", type=int, nargs="+", default=[], metavar="NODE_ID",
                        help="Optional diagnostic: make the listed nodes' world-Z rotation equal to the first node")
    args = parser.parse_args()
    if args.count < 1 or len(args.tie_tower_yaw) == 1:
        parser.error("count must be positive; a tower yaw tie needs at least two nodes")
    directory = args.directory.resolve()
    reference, reference_vectors, descriptions, source_hash = reference_modes(directory, args.count)
    native, native_vectors, node_ids, native_audit = native_modes(args.built.resolve(), args.catalog.resolve(), args.count, args.tie_tower_yaw)
    report = {
        "openfastRelease": RELEASE, "rTestRevision": REVISION,
        "linearizationSha256": source_hash,
        "builtPath": str(args.built.resolve()), "builtSha256": hashlib.sha256(args.built.read_bytes()).hexdigest(),
        "assumptions": {"gravity": 0., "rotorSpeed": 0., "pitch": 0., "fluidLoads": False,
                        "shaft": "HSS locked relative to nacelle", "nativePrestress": False,
                        "diagnosticTiedTowerYawNodeIds": args.tie_tower_yaw},
        "comparisonLimit": "Native full beam tower retains torsion; ElastoDyn tower has bending modes only. Sorted indices do not establish matching mode shapes. OpenFAST frequency is the magnitude of its damped state eigenvalue; native uses undamped K/M.",
        "reference": reference, "native": native, "referenceStateDescriptions": descriptions,
        "nativeGravityAndVerticalModesAudit": native_audit,
    }
    name = "modal_tied_tower_yaw" if args.tie_tower_yaw else "modal_full_tower"
    output = directory / "model/stationary" / name
    output.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    np.savez(output.with_suffix(".npz"), nativeModes=native_vectors, nodeIds=node_ids,
             referenceModesReal=reference_vectors.real, referenceModesImag=reference_vectors.imag)
    print("index native_Hz OpenFAST_Hz (indices alone do not match mode shapes)")
    for i, (a, b) in enumerate(zip(native, reference), start=1):
        print(f"{i:2d} {a['frequencyHz']:.8f} {b['frequencyHz']:.8f}")
    print(output.with_suffix(".json"))
