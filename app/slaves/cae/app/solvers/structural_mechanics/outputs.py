"""수치 배열을 기존 ABI 값으로 포장한다. 물리량마다 단위를 분리한다."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue

from .continuum import element_response
from .domain import parameter
from .rotations import rotation_log
from .shells import shell_frame


def configure_history(model, outputs):
    """출력별 절점 순서는 유지하고, 저장에는 요청 절점의 합집합만 씁니다."""
    lookup = {int(node): index for index, node in enumerate(model.node_ids)}
    selected = []
    for output in outputs:
        if output["methodId"] != "fea.history":
            continue
        parameters = output.get("parameters", {})
        scope = parameter(parameters.get("scope", "cumulative"))
        if scope not in ("cumulative", "latest-window", "final"):
            raise ValueError("history scope must be cumulative, latest-window or final")
        ids = np.asarray(parameter(parameters.get("nodeIds", model.node_ids)))
        if ids.ndim != 1 or len(np.unique(ids)) != len(ids):
            raise ValueError("history nodeIds must be a one-dimensional list of unique node IDs")
        for node in ids:
            if int(node) not in lookup:
                raise ValueError(f"history node ID {int(node)} is absent from the structural model")
            index = lookup[int(node)]
            if index not in selected:
                selected.append(index)
    model.history_nodes = np.asarray(selected, dtype=int)


def history_members(model, solution, node_ids=None, scope="cumulative", complete=True):
    """요청한 범위에서만 이력 조각을 펼쳐 공개 tensor를 만듭니다.

    final은 마지막 연성 구간이 수렴하기 전까지 sample 축 길이가 0입니다.
    따라서 중간 trial마다 과거 전체 배열을 다시 만드는 비용이 없습니다.
    latest-window는 최근 구간에서 기록한 표본만, cumulative는 t=0부터의
    모든 표본을 반환합니다. nodeIds는 배열 열과 실제 모델 절점을 연결합니다.
    """
    stored_nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    stored_ids = model.node_ids[stored_nodes]
    requested = stored_ids if node_ids is None else np.asarray(node_ids)
    lookup = {int(node): index for index, node in enumerate(stored_ids)}
    selection = np.asarray([lookup[int(node)] for node in requested], dtype=int)
    members = {"nodeIds": np.asarray(requested, dtype=np.int32)}
    nodal = {"displacement", "rotation", "velocity", "reaction", "reactionMoment"}
    for name, chunks in solution.history.items():
        if scope == "final" and not complete:
            shape = (0, len(selection), 3) if name in nodal else (0,)
            members[name] = np.empty(shape, dtype=float)
            continue
        chunks = chunks[-1:] if scope == "latest-window" else chunks
        selected = [np.asarray(chunk)[:, selection] if name in nodal else np.asarray(chunk) for chunk in chunks]
        members[name] = np.concatenate(selected, axis=0)
    return members


def interface_members(model):
    frames = np.tile(np.eye(3), (len(model.points), 1, 1))
    for element in model.elements:
        if element.kind == "beam2":
            frames[element.nodes] = element.section["frame"]
    return {"modelIdentity": model.identity, "nodeIds": model.node_ids.astype(np.int32), "referencePositions": model.points, "referenceOrientations": frames}


def build_outputs(config, descriptor, model, solution, motion=None, *, history_complete=True):
    blocks = {}
    for element in model.elements:
        blocks.setdefault(element.kind, []).append(element.nodes)
    for contact in model.contacts:
        blocks.setdefault("contact-tri3", []).extend(contact["faces"])
    if not blocks:
        # 집중질량/스프링만으로 만든 모델도 유효하다. 점을 임의의 체적 요소로 만들지 않는다.
        blocks["vertex"] = np.arange(len(model.points)).reshape(-1, 1)
    domain = UnstructuredMeshValue(model.points, {kind: np.asarray(rows, dtype=np.int32) for kind, rows in blocks.items()}, "m", model.identity, {"provenance": model.provenance, "nodeIds": model.node_ids, "nodeSets": model.node_sets, "faceSets": model.face_sets})
    interface = interface_members(model)
    artifacts = {}
    for output in config["outputs"]:
        method, key = output["methodId"], output["key"]
        definition = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == method)
        data = definition["data"]
        if method in ("fea.displacement", "fea.rotation", "fea.reaction", "fea.reaction-moment"):
            rotations = np.asarray([rotation_log(rotation) for rotation in solution.orientations])
            values = {"fea.displacement": solution.displacement[:, :3], "fea.rotation": rotations, "fea.reaction": solution.reaction[:, :3], "fea.reaction-moment": solution.reaction[:, 3:]}[method]
            artifacts[key] = FieldValue(domain, "node", data["quantityKind"], data["unit"], values, data.get("basis"), ("x", "y", "z"))
            continue
        if method == "fea.interface":
            artifacts[key] = BundleValue("caemble.mechanics/interface@1", interface)
            continue
        if method == "fea.motion":
            if motion is None:
                raise ValueError("motion waveform output requires transient analysis")
            artifacts[key] = motion
            continue
        if method == "fea.history":
            parameters = output.get("parameters", {})
            node_ids = parameter(parameters.get("nodeIds", model.node_ids))
            scope = parameter(parameters.get("scope", "cumulative"))
            members = history_members(model, solution, node_ids, scope, history_complete)
        elif method == "fea.modes":
            members = {"frequencies": solution.spectrum["frequencies"], "displacement": solution.spectrum["modes"][:, :, :3], "rotation": solution.spectrum["modes"][:, :, 3:]}
        elif method == "fea.buckling":
            members = {"factors": solution.spectrum["factors"], "displacement": solution.spectrum["modes"][:, :, :3], "rotation": solution.spectrum["modes"][:, :, 3:]}
        elif method == "fea.harmonic":
            value = solution.spectrum["response"]
            members = {"frequencies": solution.spectrum["frequencies"], "displacementReal": value[:, :, :3].real.copy(), "displacementImag": value[:, :, :3].imag.copy(), "rotationReal": value[:, :, 3:].real.copy(), "rotationImag": value[:, :, 3:].imag.copy()}
        elif method == "fea.section-forces":
            forces, moments = [], []
            for element, result in zip(model.elements, solution.stresses):
                if element.kind == "beam2" and result is not None:
                    forces.append(result["force"])
                    moments.append(result["moment"])
            members = {"force": np.asarray(forces, dtype=float).reshape(-1, 2, 3), "moment": np.asarray(moments, dtype=float).reshape(-1, 2, 3)}
        elif method == "fea.stress":
            ids, ply_ids, point_ids, stress_values, plastic_values, equivalent, stress_bases = [], [], [], [], [], [], []
            for index, (element, result, history) in enumerate(zip(model.elements, solution.stresses, solution.element_history)):
                if result is None or element.kind in ("beam2", "truss2"):
                    continue
                if element.kind == "shell4":
                    local = result["plyStress"].reshape(-1, 3)
                    # 각 적분점/층의 아래면, 위면 순서다. 이를 보존해야 특정 층 응력을 찾을 수 있다.
                    point_count, ply_count = result["plyStress"].shape[:2]
                    ply_ids.extend(np.tile(np.repeat(np.arange(ply_count), 2), point_count))
                    point_ids.extend(np.repeat(np.arange(point_count), ply_count * 2))
                else:
                    local = np.asarray(result)
                    if element.kind in ("tri3", "quad4"):
                        # 평면변형률의 두께 방향 반응 응력까지 3D 재료 법칙으로
                        # 회복한다. 내부 2D 조립에 쓰지 않는 성분도 출력에는 필요하다.
                        local = element_response(element.kind, model.points[element.nodes, :2], solution.displacement[element.nodes, :2].ravel(), element.material["C"], element.section.get("thickness", 1.), element.section.get("plane", "stress"), full_stress=True)[1]
                    ply_ids.extend([-1] * len(local))
                    point_ids.extend(range(len(local)))
                stress = np.zeros((len(local), 6))
                if local.shape[1] == 3:
                    stress[:, [0, 1, 3]] = local
                else:
                    stress[:] = local
                ids.extend([index] * len(stress))
                stress_values.extend(stress)
                # 열 벡터가 응력 좌표축의 세계 XYZ 성분이다. 쉘은 기준 요소
                # 축을 쓰므로, 이 행렬을 기록해야 곡면의 응력 방향을 복원할 수 있다.
                basis = shell_frame(model.points[element.nodes])[1][:3, :3].T if element.kind == "shell4" else np.eye(3)
                stress_bases.extend([basis] * len(stress))
                plastic_values.extend(np.zeros_like(stress) if history is None else history["plasticStrain"])
                equivalent.extend(np.zeros(len(stress)) if history is None else history["equivalentPlasticStrain"])
            members = {"elementIds": np.asarray(ids, dtype=np.int32), "plyIds": np.asarray(ply_ids, dtype=np.int32), "integrationPointIds": np.asarray(point_ids, dtype=np.int32), "stress": np.asarray(stress_values, dtype=float).reshape(-1, 6), "plasticStrain": np.asarray(plastic_values, dtype=float).reshape(-1, 6), "equivalentPlasticStrain": np.asarray(equivalent, dtype=float), "stressBasis": np.asarray(stress_bases, dtype=float).reshape(-1, 3, 3)}
        else:
            raise ValueError(f"unsupported structural output {method}")
        # 배열의 shape만 기록하면 Calculation은 축의 실제 좌표를 알 수 없습니다.
        # 기존 tensor의 value/axes 표현을 사용해 시간과 절점 ID를 함께 보냅니다.
        # 이 포장은 기록 출력 경계에만 적용합니다. 연성 motion/interface와
        # 계산 중의 history_members는 계속 원래의 수치 배열을 사용합니다.
        coordinates = {"node": (members.get("nodeIds", model.node_ids), None)}
        if method == "fea.history":
            coordinates["sample"] = (members["times"], "s")
        if method == "fea.harmonic":
            coordinates["frequency"] = (members["frequencies"], "Hz")
        if method == "fea.section-forces":
            coordinates["element"] = (np.asarray([index for index, (element, result) in enumerate(zip(model.elements, solution.stresses)) if element.kind == "beam2" and result is not None]), None)
        recorded_members = {}
        for name, values in members.items():
            axes = []
            for axis in data["members"][name].get("axes", ()):
                coordinate = coordinates.get(axis.get("name"))
                if coordinate is None:
                    # 모드 번호, 적분점 행 번호, 성분 번호는 물리 좌표가 아닌 순서입니다.
                    axes.append({"implicitOrdinal": True})
                else:
                    ticks, unit = coordinate
                    axes.append({"ticks": ticks, **({"unit": unit} if unit is not None else {})})
            recorded_members[name] = {"value": values, "axes": axes}
        artifact_type = definition.get("artifactType", "caemble.mechanics/" + method.removeprefix("fea.") + "@1")
        artifacts[key] = BundleValue(artifact_type, recorded_members)
    return artifacts
