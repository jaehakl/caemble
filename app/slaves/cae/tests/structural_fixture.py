"""Explicit numerical fixtures; never a public Solver input path."""

import hashlib
import numpy as np
from app.kernel.api.world import geometry_parts
from app.solvers.structural_mechanics.domain import parameter, selected_material, update_fingerprint
from app.solvers.structural_mechanics.beam import beam_frame, isotropic_beam_section, physical_beam_mass
from app.solvers.structural_mechanics.constraints import revolute_joints
from app.solvers.structural_mechanics.materials import orient_elasticity
from app.solvers.structural_mechanics.meshing import brick_mesh, cylinder_mesh, line_mesh, plate_mesh
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.shells import laminate_section


def build_model(invocation):
    config = invocation.config
    initializations = []
    point_blocks, id_blocks = [], []
    for rule in config["initializations"]:
        method = rule["methodId"]
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if method == "fea.nodes":
            id_blocks.append(np.asarray(p["nodeIds"], dtype=np.int64))
            point_blocks.append(np.asarray(p["positions"], dtype=float).reshape(-1, 3))
        elif method in ("fea.line-mesh", "fea.plate-mesh", "fea.cylinder-mesh", "fea.brick-mesh"):
            if method == "fea.line-mesh":
                generated, cells = line_mesh(p["start"], p["end"], int(p["divisions"]))
                kind, role = "beam2", "lineDomain"
                section = {name: p[name] for name in ("area", "inertias", "shearAreas", "orientation")}
                section["dampingStiffness"] = p.get("dampingStiffness", 0.0)
            elif method == "fea.plate-mesh":
                generated, cells = plate_mesh(p["origin"], p["size"], p["divisions"])
                kind, role, section = "shell4", "plateDomain", {"thickness": p["thickness"]}
            elif method == "fea.cylinder-mesh":
                generated, cells = cylinder_mesh(p["origin"], p["radius"], p["height"], p["divisions"])
                kind, role, section = "shell4", "cylinderDomain", {"thickness": p["thickness"]}
            else:
                generated, cells = brick_mesh(p["origin"], p["size"], p["divisions"])
                kind, role, section = "hex8", "brickDomain", {"materialAxes": p.get("materialAxes", np.eye(3))}
            ids = np.arange(int(p["nodeIdStart"]), int(p["nodeIdStart"]) + len(generated), dtype=np.int64)
            point_blocks.append(generated)
            id_blocks.append(ids)
            initializations.append({"methodId": "fea." + kind, "target": rule["target"], "parameters": {"connectivity": ids[cells], **section}, "materialRole": role, "generatorMethod": method})
        else:
            initializations.append(rule)
    if not point_blocks:
        raise ValueError("a structural model needs explicit nodes or a mesh generation method")
    node_ids = np.concatenate(id_blocks)
    points = np.concatenate(point_blocks)
    if len(node_ids) != len(points) or len(set(node_ids.tolist())) != len(points):
        raise ValueError("structural node IDs must be unique and match the coordinate rows")
    lookup = {int(node): i for i, node in enumerate(node_ids)}
    model = StructuralModel(node_ids, points, [], np.empty(0, dtype=int), np.empty(0, dtype=int), np.zeros((len(points), 6)))
    active = set()
    fixed = set()
    roles = {"truss2": "trussDomain", "beam2": "beamDomain", "generalized-beam2": "generalizedBeamDomain", "tri3": "triDomain", "quad4": "quadDomain", "tet4": "tetDomain", "hex8": "hexDomain", "shell4": "shellDomain"}
    layers = {}
    element_blocks = []
    for rule in initializations:
        if rule["methodId"] != "fea.layer":
            continue
        material, root_id = selected_material(invocation, rule, "layerDomain")
        params = rule["parameters"]
        layers.setdefault(root_id, []).append({"elasticity": material["C"], "G13": material["C"][5, 5], "G23": material["C"][4, 4], "density": material["density"], "thickness": float(parameter(params["thickness"])), "angle": float(parameter(params["angle"]))})
    for rule in initializations:
        method = rule["methodId"].removeprefix("fea.")
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if method in roles:
            material, root_id = selected_material(invocation, rule, rule.get("materialRole", roles[method]))
            if material["model"] == "mechanics.j2-plasticity@1" and method not in ("tet4", "hex8"):
                raise ValueError("J2 plasticity is supported by solid elements only")
            if method in ("truss2", "beam2") and material["model"] != "mechanics.isotropic-elastic@1":
                raise ValueError("use an explicitly coupled generalized beam section for anisotropic beams")
            section = {key: value for key, value in p.items() if key != "connectivity"}
            kind = method
            if method in ("tri3", "quad4", "tet4", "hex8"):
                axes = np.asarray(p.get("materialAxes", np.eye(3)), dtype=float)
                if method in ("tri3", "quad4") and not np.allclose(axes[:, 2], [0., 0., 1.], rtol=0, atol=1e-10):
                    raise ValueError("plane materialAxes must preserve the plane normal +Z")
                material["C"] = orient_elasticity(material["C"], axes)
            if method == "shell4":
                section = laminate_section(layers.get(root_id, [{"elasticity": material["C"], "G13": material["C"][5, 5], "G23": material["C"][4, 4], "density": material["density"], "thickness": p["thickness"], "angle": 0.0}]))
            elif method == "beam2":
                section["stiffness"], section["mass"] = isotropic_beam_section(material["E"], material["nu"], material["density"], p["area"], p["inertias"], p["shearAreas"])
                if float(p.get("dampingStiffness", 0.0)) < 0:
                    raise ValueError("beam stiffness-proportional damping cannot be negative")
                section["damping"] = float(p.get("dampingStiffness", 0.0)) * section["stiffness"]
            elif method == "generalized-beam2":
                kind = "beam2"
                A, B, D = (np.asarray(p[name], dtype=float).reshape(3, 3) for name in ("stiffnessForce", "stiffnessCoupling", "stiffnessMoment"))
                section["stiffness"] = np.block([[A, B], [B.T, D]])
                A, B, D = (np.asarray(p[name], dtype=float).reshape(3, 3) for name in ("massTranslation", "massCoupling", "massRotation"))
                section["mass"] = np.block([[A, B], [B.T, D]])
                A, B, D = (np.asarray(p.get(name, np.zeros((3, 3))), dtype=float).reshape(3, 3) for name in ("dampingForce", "dampingCoupling", "dampingMoment"))
                section["damping"] = np.block([[A, B], [B.T, D]])
                for matrix in (section["stiffness"], section["mass"]):
                    diagonal = np.diag(matrix)
                    if np.any(diagonal <= 0):
                        raise ValueError("beam section matrices must have positive diagonal entries")
                    # 단위가 다른 병진/회전 블록을 에너지 척도로 정규화한다.
                    # 좌표 회전의 부동소수점 반올림만 허용하고 비대칭 물성은 거부한다.
                    scaled = matrix / np.sqrt(np.outer(diagonal, diagonal))
                    if not np.allclose(scaled, scaled.T, rtol=0, atol=1e-12):
                        raise ValueError("beam section matrices must be symmetric")
                    matrix[:] = (matrix + matrix.T) / 2
                    np.linalg.cholesky(matrix)
                damping = section["damping"]
                if np.any(damping):
                    diagonal = np.diag(damping)
                    scale = np.sqrt(np.maximum(abs(diagonal), np.max(abs(diagonal)) * 1e-12))
                    normalized = damping / np.outer(scale, scale)
                    if not np.allclose(normalized, normalized.T, rtol=0, atol=1e-12) or np.linalg.eigvalsh((normalized + normalized.T) / 2).min() < -1e-10:
                        raise ValueError("beam section damping must be symmetric positive semidefinite")
                    damping[:] = (damping + damping.T) / 2
            connectivity = np.asarray(p["connectivity"], dtype=np.int64)
            first_element = len(model.elements)
            for row in connectivity:
                nodes = np.array([lookup[int(node)] for node in row])
                if kind in ("tri3", "quad4") and np.ptp(points[nodes, 2]) > 1e-10 * max(np.linalg.norm(np.ptp(points[nodes], axis=0)), 1.0):
                    raise ValueError("plane elements require a common XY plane; use a shell for a curved or tilted surface")
                element_section = section.copy()
                if kind == "beam2":
                    element_section["frame"] = beam_frame(points[nodes], np.asarray(section["orientation"], dtype=float))
                model.elements.append(Element(kind, nodes, material, element_section, root_id))
                components = 6 if kind in ("beam2", "shell4") else 2 if kind in ("tri3", "quad4") else 3
                active.update(6 * int(node) + dof for node in nodes for dof in range(components))
            # 같은 CAD root에 속한 여러 입력 블록도 각각의 요소 번호로 구분합니다.
            # 공개 mesh metadata의 provenance에 실려 상세 응답의 원래 CAD를 찾습니다.
            element_blocks.append({"methodId": rule.get("generatorMethod", rule["methodId"]), "target": list(rule["target"]), "rootId": root_id, "cellType": kind, "elementIds": np.arange(first_element, len(model.elements), dtype=np.int32)})
        elif method in ("node-set", "face-set"):
            # 입력 순서와 사용자 ID를 보존한다. 좌표를 비교해 CAD 면을 추측하거나
            # 번호를 내부 행 번호로 바꾸면 나중에 같은 집합을 찾기 어려워진다.
            name = p["name"]
            sets = model.node_sets if method == "node-set" else model.face_sets
            if not isinstance(name, str) or not name.strip() or name in sets:
                raise ValueError("named mesh sets require a nonempty name unique within their kind")
            if len(rule["target"]) != 1:
                raise ValueError("a named mesh set requires exactly one Geometry target")
            source, _, group = rule["target"][0].split(".", 2)
            parts = geometry_parts(invocation.world[source], group)
            if len(parts) != 1:
                raise ValueError("a named mesh set requires exactly one CAD root")
            entry = {"target": list(rule["target"]), "rootId": parts[0]["id"], "source": source, "geometryHash": invocation.world[source]["geometryHash"]}
            key = "nodeIds" if method == "node-set" else "faces"
            ids = np.asarray(p[key])
            if ids.dtype.kind not in "iu" or np.any(ids < np.iinfo(np.int32).min) or np.any(ids > np.iinfo(np.int32).max):
                raise ValueError("named mesh sets require int32 node IDs")
            if method == "node-set":
                if ids.ndim != 1 or ids.size == 0 or len(np.unique(ids)) != len(ids):
                    raise ValueError("node-set nodeIds must be a nonempty one-dimensional list of unique IDs")
            else:
                kind = p["kind"]
                if kind not in ("tri3", "quad4") or ids.ndim != 2 or ids.shape[0] == 0 or ids.shape[1] != (3 if kind == "tri3" else 4):
                    raise ValueError("face-set faces must be nonempty tri3 or quad4 connectivity with matching arity")
                if any(len(np.unique(row)) != len(row) for row in ids) or len({tuple(sorted(row)) for row in ids}) != len(ids):
                    raise ValueError("face-set requires distinct vertices per face and no repeated faces")
                entry["kind"] = kind
            if any(int(node) not in lookup for node in ids.flat):
                raise ValueError("a named mesh set references a node ID absent from the structural model")
            entry[key] = np.array(ids, dtype=np.int32, copy=True)
            sets[name] = entry
        elif method == "mass":
            node = lookup[int(p["nodeId"])]
            inertia = np.asarray(p["inertia"], dtype=float).reshape(3, 3)
            if float(p["mass"]) < 0 or not np.allclose(inertia, inertia.T) or np.linalg.eigvalsh(inertia).min() < -1e-10 * max(np.linalg.norm(inertia), 1.0):
                raise ValueError("concentrated mass and symmetric inertia must be nonnegative")
            model.masses.append((node, float(p["mass"]), inertia))
            active.update(6 * node + i for i in range(3))
            active.update(6 * node + 3 + i for i in range(3) if np.any(inertia[i]))
        elif method in ("translation-spring", "rotation-spring"):
            allowed = range(3) if method == "translation-spring" else range(3, 6)
            if int(p["dofA"]) not in allowed or (int(p["nodeB"]) != -1 and int(p["dofB"]) not in allowed) or min(p["stiffness"], p["damping"]) < 0:
                raise ValueError("spring/damper components must match their unit and coefficients must be nonnegative")
            a = lookup[int(p["nodeA"])] * 6 + int(p["dofA"])
            b = -1 if int(p["nodeB"]) == -1 else lookup[int(p["nodeB"])] * 6 + int(p["dofB"])
            model.springs.append((a, b, float(p["ratio"]), float(p["stiffness"]), float(p["damping"])))
            active.add(a)
            if b >= 0:
                active.add(b)
        elif method == "rigid-link":
            a, b = lookup[int(p["master"])], lookup[int(p["slave"])]
            components = np.asarray(p["components"], dtype=int)
            if not set(components) <= set(range(6)) or len(set(components)) != len(components):
                raise ValueError("rigid-link components must be unique DOF indices from 0 to 5")
            model.links.append((a, b, components))
            active.update(6 * node + dof for node in (a, b) for dof in range(6))
        elif method == "rotor":
            rotor = dict(p)
            for name in ("hubNode", "nacelleNode", "generatorNode"):
                rotor[name] = lookup[int(p[name])]
            rotor["bladeRootNodes"] = np.asarray([lookup[int(node)] for node in p["bladeRootNodes"]])
            rotor["bladeNodeIds"] = np.asarray([[lookup[int(node)] for node in row] for row in p["bladeNodeIds"]])
            if not np.allclose(rotor["axis"], [1, 0, 0]):
                raise ValueError("the aligned rotor joint currently requires world +X shaft axis")
            model.rotor = rotor
            nacelle, hub, generator = (rotor[key] for key in ("nacelleNode", "hubNode", "generatorNode"))
            model.links.extend((nacelle, node, np.array([0, 1, 2, 4, 5])) for node in (hub, generator))
            model.links.extend((hub, int(node), np.arange(6)) for node in rotor["bladeRootNodes"])
            model.springs.append((hub * 6 + 3, generator * 6 + 3, 1 / p["gearRatio"], p["shaftStiffness"], p["shaftDamping"]))
            active.update(6 * node + dof for node in (nacelle, hub, generator, *rotor["bladeRootNodes"]) for dof in range(6))
    if model.face_sets:
        # 면 집합은 실제 해석 요소의 면이어야 한다. 내부 면도 이름 붙일 수
        # 있지만 다른 CAD root의 면이나 임의 절점 조합은 허용하지 않는다.
        local_faces = {
            "tri3": ((0, 1, 2),), "quad4": ((0, 1, 2, 3),), "shell4": ((0, 1, 2, 3),),
            "tet4": ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
            "hex8": ((0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)),
        }
        available = set()
        for element in model.elements:
            for face in local_faces.get(element.kind, ()):
                ids = node_ids[element.nodes[np.asarray(face)]]
                available.add((element.root_id, tuple(sorted(ids))))
        for entry in model.face_sets.values():
            if any((entry["rootId"], tuple(sorted(row))) not in available for row in entry["faces"]):
                raise ValueError("face-set connectivity must identify an actual element face belonging to its target CAD root")
    for rule in config["boundaryConditions"]:
        method = rule["methodId"]
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if method == "fea.fixed":
            if not set(p["components"]) <= set(range(6)):
                raise ValueError("fixed components must be DOF indices from 0 to 5")
            fixed.update(6 * lookup[int(node)] + int(dof) for node in p["nodeIds"] for dof in p["components"])
        elif method == "fea.nodal-force":
            nodes = [lookup[int(node)] for node in p["nodeIds"]]
            np.add.at(model.force[:, :3], nodes, np.asarray(p["forces"]))
            np.add.at(model.force[:, 3:], nodes, np.asarray(p["moments"]))
        elif method == "fea.gravity":
            model.gravity = np.asarray(p["acceleration"], dtype=float)
        elif method == "fea.contact":
            if p["penalty"] <= 0:
                raise ValueError("contact penalty must be positive")
            model.contacts.append({"slaves": np.asarray([lookup[int(node)] for node in p["slaves"]]), "faces": np.asarray([[lookup[int(node)] for node in row] for row in p["faces"]]), "penalty": float(p["penalty"])})
    model.active = np.asarray(sorted(active), dtype=int)
    model.fixed = np.asarray(sorted(fixed), dtype=int)
    dependent = {6 * slave + int(component) for _, slave, components in model.links for component in components}
    if fixed & dependent:
        # 연결이 slave의 운동을 이미 결정한다. 같은 성분을 다시 지지하면
        # master의 허용 운동과 모순될 수 있으므로 지지는 master에 지정한다.
        # revolute의 자유 상대각 q는 components에 없으므로 직접 잠글 수 있다.
        raise ValueError("fixed support cannot target a rigid-link dependent DOF; prescribe the corresponding support on its master")
    if bool(parameter(config["parameters"].get("geometricNonlinear", False))):
        if parameter(config["parameters"].get("analysis", "static")) in ("static", "transient"):
            # 모달/조화응답은 회전 설정과 무관하게 기준 선형 M을 사용한다.
            for element in model.elements:
                if element.kind == "beam2":
                    physical_beam_mass(element.section["mass"])
        for _, _, components in model.links:
            translation = set(components) & {0, 1, 2}
            rotation = set(components) & {3, 4, 5}
            if len(rotation) not in (0, 3) and not (len(rotation) == 2 and len(translation) == 3):
                # 공간 회전 성분 몇 개를 복사하는 것만으로 유한 상대 자세를
                # 정의할 수 없다. 구현된 전체 자세 연결과 revolute만 허용한다.
                raise ValueError("finite-rotation rigid-link requires no rotational tie, all three rotations, or three translations plus two rotations for a revolute joint")
        joints = revolute_joints(model)
        slaves = {slave for _, slave, _ in model.links}
        for a, b, ratio, stiffness, _ in model.springs:
            if stiffness == 0:
                continue  # 공간 각속도에 비례하는 순수 댐퍼는 회전각 퍼텐셜을 쓰지 않는다.
            for dof in (a, b if ratio != 0 else -1):
                if dof < 0 or dof % 6 < 3:
                    continue
                node, component = divmod(dof, 6)
                joint_angle = node in joints and component == 3 + joints[node][1]
                fixed_axis = node not in slaves and all(6 * node + other in fixed for other in range(3, 6) if other != component)
                # 다축 유한회전에서는 누적 공간 성분을 보존적인 스프링 각도로
                # 사용할 수 없다. 실제 상대각 q 또는 하나의 고정축만 허용한다.
                if not joint_angle and not fixed_axis:
                    raise ValueError("finite-rotation spring requires a revolute joint coordinate or an independent fixed-axis node with the other two rotations fixed")
    inactive = np.ones(model.size, dtype=bool)
    inactive[model.active] = False
    if np.any(model.force.ravel()[inactive] != 0):
        raise ValueError("a nodal force/moment acts on a DOF absent from the selected element/connection model")
    model.provenance = {source: invocation.world[source]["geometryHash"] for source in ("experiment", "task") if source in invocation.world}
    model.provenance["elementBlocks"] = element_blocks
    # 절점 수가 같아도 다른 모델의 상태를 재사용할 수 없다. 형상·재료·연결을 식별한다.
    fingerprint = hashlib.sha256(b"structural-mechanics-model-v1")
    update_fingerprint(fingerprint, (points, node_ids, config, model.provenance, [(e.kind, e.nodes, e.material, e.section, e.root_id) for e in model.elements]))
    model.identity = fingerprint.hexdigest()
    return model
