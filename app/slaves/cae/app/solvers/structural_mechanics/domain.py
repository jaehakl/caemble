"""CSG와 물리 조건에서 구조 Solver가 소유하는 체적 계산 모델을 만든다."""

import hashlib
import marshal
import struct
from collections.abc import Mapping

import numpy as np

from app.kernel.api.world import geometry_part, geometry_parts, material_model
from app.methods.mesh.models import VolumeMeshingProfile

from .constraints import revolute_joints
from .materials import isotropic_elasticity, orient_elasticity, orthotropic_elasticity
from .model import Element, StructuralModel


def parameter(value):
    """현재 Catalog의 scalar/tensor leaf만 읽는다. 별도 JSON 포맷은 없다."""
    return value["value"] if isinstance(value, Mapping) else value


def update_fingerprint(fingerprint, value):
    """출력 문자열이 아닌 전체 값으로 checkpoint의 모델 식별자를 만듭니다.

    NumPy repr은 표시 자릿수를 반올림하고 큰 배열의 가운데를 생략합니다.
    그러므로 눈으로 똑같이 보이는 두 강성 행렬도 다른 물리 모델일 수 있습니다.
    배열은 dtype·shape·모든 원소의 바이트를, 실수는 IEEE 754의 8바이트를
    해시합니다. 긴 숫자 목록은 C로 구현된 marshal 인코더로 한 번에 포장합니다.
    이 이진 표현은 float의 모든 bit와 정수/실수/불리언의 타입을 보존합니다.
    별도 입력 형식이 아니라 해시 내부의 포장입니다. 항목의 타입과 길이로 서로 다른
    트리를 구분하며 사전 순서와 배열의 메모리 배치/바이트 순서는 식별에 영향을 주지 않습니다.
    """
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, Mapping):
        fingerprint.update(b"mapping" + len(value).to_bytes(8, "little"))
        for key in sorted(value):
            if isinstance(key, str):
                encoded_key = key.encode("utf-8")
                fingerprint.update(b"string" + len(encoded_key).to_bytes(8, "little") + encoded_key)
            else:
                update_fingerprint(fingerprint, key)
            update_fingerprint(fingerprint, value[key])
        return
    if isinstance(value, (list, tuple)):
        first = value
        while isinstance(first, (list, tuple)) and len(first):
            first = first[0]
        payload = None
        if isinstance(first, (bool, int, float, np.number, np.bool_)):
            try:
                # 정규 숫자 tensor만 묶습니다. object 배열은 [1, 2.]의 int/float를
                # 그대로 두고 tuple/list 중첩만 list로 통일합니다. marshal v2는
                # 별칭 공유를 기록하지 않아 메모리상의 객체 재사용 여부와 무관합니다.
                numeric = np.asarray(value)
                if numeric.dtype.kind in "biuf":
                    payload = marshal.dumps(np.asarray(value, dtype=object).tolist(), 2)
            except (TypeError, ValueError):
                # 문자열/사전이 섞이거나 행 길이가 다르면 원래의 재귀 경로입니다.
                payload = None
        if payload is not None:
            fingerprint.update(b"numeric-sequence" + len(payload).to_bytes(8, "little"))
            fingerprint.update(payload)
            return
        fingerprint.update(b"sequence" + len(value).to_bytes(8, "little"))
        for item in value:
            update_fingerprint(fingerprint, item)
        return
    if isinstance(value, np.ndarray):
        if value.dtype.kind not in "biufc":
            raise TypeError("structural model fingerprints require numeric arrays")
        array = np.asarray(value, dtype=value.dtype.newbyteorder("<"), order="C")
        dtype_name = array.dtype.str.encode("ascii")
        # 고정 길이 정수로 dtype 문자열 길이와 차원 수를 먼저 적어 경계를 보존합니다.
        fingerprint.update(b"array" + struct.pack("<I", len(dtype_name)) + dtype_name + struct.pack("<I", array.ndim) + struct.pack("<" + "Q" * array.ndim, *array.shape))
        payload = array.tobytes(order="C")
    elif value is None:
        fingerprint.update(b"none")
        return
    elif isinstance(value, bool):
        fingerprint.update(b"bool")
        payload = bytes([value])
    elif isinstance(value, int):
        fingerprint.update(b"int")
        payload = str(value).encode("ascii")
    elif isinstance(value, float):
        fingerprint.update(b"float")
        payload = struct.pack("<d", value)
    elif isinstance(value, str):
        fingerprint.update(b"string")
        payload = value.encode("utf-8")
    else:
        raise TypeError(f"unsupported structural fingerprint value {type(value).__name__}")
    fingerprint.update(len(payload).to_bytes(8, "little"))
    fingerprint.update(payload)


def selected_material(invocation, rule, role, part=None):
    source, _, group = rule["target"][0].split(".", 2)
    part = geometry_part(invocation.world[source], group) if part is None else part
    selected = material_model(invocation.world, part, role, "constitutive", source)
    if selected is None:
        raise ValueError(f"{role} requires an explicitly selected constitutive model")
    result = {key: parameter(value) for key, value in selected["parameters"].items()}
    result["model"] = selected["model"]
    if selected["model"] in ("mechanics.isotropic-elastic@1", "mechanics.j2-plasticity@1"):
        result["C"] = isotropic_elasticity(result["E"], result["nu"])
    elif selected["model"] == "mechanics.orthotropic-elastic@1":
        result["C"] = orthotropic_elasticity(*(result[name] for name in ("E1", "E2", "E3", "nu12", "nu23", "nu13", "G12", "G23", "G13")))
    else:
        raise ValueError(f"unsupported structural material {selected['model']}")
    if result["density"] <= 0:
        raise ValueError("structural density must be positive")
    return result, part["id"]


def surface_region(model, target):
    """Semantic targets resolve through saved Boolean provenance, never node numbers."""
    if target not in model.boundary_regions:
        raise ValueError(f"structural surface target {target!r} is absent from the generated domain")
    region = model.boundary_regions[target]
    if not len(region["faces"]):
        raise ValueError(f"structural surface target {target!r} has no remaining boundary after Boolean evaluation")
    return region


def attachment(model, target, references, active):
    """An area-centroid reference carries a rigid attachment patch's six motions."""
    if target in references:
        return references[target]
    region = surface_region(model, target)
    nodes = region["nodes"]
    existing = {slave for _, slave, _ in model.links}
    if existing.intersection(map(int, nodes)):
        raise ValueError("attachment patches overlap; use a shared surface group for the common attachment")
    center = region["referencePoint"]
    coordinates = model.points[nodes] - center
    if np.linalg.matrix_rank(coordinates, tol=np.linalg.norm(coordinates) * 1e-12) < 2:
        raise ValueError("a rotational attachment requires a non-collinear surface patch")
    node = len(model.points)
    model.points = np.vstack((model.points, center))
    model.node_ids = np.append(model.node_ids, node)
    model.force = np.vstack((model.force, np.zeros(6)))
    model.links.extend((node, int(slave), np.arange(3)) for slave in nodes)
    active.update(range(6 * node, 6 * node + 6))
    references[target] = node
    return node


def distribute_resultant(points, faces, force, moment, reference):
    """Area-weighted minimum-work distribution preserving all six resultants."""
    nodes, inverse = np.unique(faces.ravel(), return_inverse=True)
    triangles = points[faces]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
    weights = np.zeros(len(nodes))
    np.add.at(weights, inverse, np.repeat(areas / 3, 3))
    weights /= weights.sum()
    arms = points[nodes] - reference
    scale = np.max(np.linalg.norm(arms, axis=1))
    if scale == 0:
        raise ValueError("surface resultant needs a finite attachment area")
    operator = np.zeros((6, len(nodes), 3))
    operator[:3] = np.eye(3)[:, None, :]
    for j, (x, y, z) in enumerate(arms / scale):
        operator[3:, j] = [[0, -z, y], [z, 0, -x], [-y, x, 0]]
    operator = operator.reshape(6, -1)
    weighted = operator * np.repeat(weights, 3)
    values = weighted.T @ np.linalg.solve(weighted @ operator.T, np.r_[force, np.asarray(moment) / scale])
    return nodes, values.reshape(-1, 3)


async def build_geometry_model(invocation):
    """The ABI path accepts CSG bodies and semantic conditions only."""
    config = invocation.config
    rotor_rules = [rule for rule in config["initializations"] if rule["methodId"] == "fea.rotor"]
    if len(rotor_rules) > 1:
        raise ValueError("structural-mechanics supports one fea.rotor initialization per task")
    parameters = {key: parameter(value) for key, value in config["parameters"].items()}
    body_rules = [rule for rule in config["initializations"] if rule["methodId"] == "fea.body"]
    if not body_rules:
        raise ValueError("structural-mechanics requires fea.body CSG targets; explicit mesh input is not supported")
    resolution = float(parameters["spatialResolution"])
    if not np.isfinite(resolution) or resolution <= 0:
        raise ValueError("spatialResolution must be a positive length")
    profile = VolumeMeshingProfile(max_element_size=resolution)
    body_parts, part_rules = {}, {}
    for rule in body_rules:
        for target in rule["target"]:
            source, kind, group = target.split(".", 2)
            if kind != "geometry":
                raise ValueError("fea.body requires Geometry targets")
            for part in geometry_parts(invocation.world[source], group):
                key = (source, part["id"])
                if key in body_parts:
                    raise ValueError("a CSG body must be selected exactly once")
                body_parts[key] = part
                part_rules[key] = {**rule, "target": [target]}
    covered_by_method = {}
    for method in ("fea.material-frame", "fea.initial-motion"):
        covered = set()
        for rule in (item for item in config["initializations"] if item["methodId"] == method):
            selected = set()
            for target in rule["target"]:
                source, kind, group = target.split(".", 2)
                if kind != "geometry":
                    raise ValueError(f"{method} requires Geometry targets")
                selected.update((source, part["id"]) for part in geometry_parts(invocation.world[source], group))
            if not selected or not selected.issubset(body_parts):
                raise ValueError(f"{method} regions must be selected by fea.body")
            if covered & selected:
                raise ValueError(f"{method} rules must not overlap the same CSG body")
            covered.update(selected)
        covered_by_method[method] = covered
    if rotor_rules:
        rotor_roots = []
        for target in rotor_rules[0]["target"]:
            source, kind, group = target.split(".", 2)
            if kind != "surface":
                raise ValueError("fea.rotor requires Surface targets")
            surface_group = next(
                (item for item in invocation.world[source]["surfaceGroups"] if item["name"] == group), None,
            )
            if surface_group is None:
                raise ValueError(f"rotor surface target {target!r} is absent from its Geometry scene")
            roots = {(source, selector["rootId"]) for selector in surface_group["selectors"]}
            if len(roots) != 1 or not roots.issubset(body_parts):
                raise ValueError("each rotor attachment must identify one selected CSG body")
            rotor_roots.append(next(iter(roots)))
        if len(set(rotor_roots)) != len(rotor_roots):
            raise ValueError("rotor attachments must identify distinct CSG bodies")
        if set(rotor_roots[1:]) & covered_by_method["fea.initial-motion"]:
            raise ValueError("initial motion on hub, generator or blade bodies requires explicit rotor superposition semantics")
    # Bodies connected by fea.bonded share an interface mesh. Other bodies retain
    # independent topology, including bodies that only touch through contact.
    clusters = [{key} for key in body_parts]
    for rule in config["initializations"]:
        if rule["methodId"] != "fea.bonded":
            continue
        selected = set()
        for target in rule["target"]:
            source, _, group = target.split(".", 2)
            selected.update((source, part["id"]) for part in geometry_parts(invocation.world[source], group))
        if not selected.issubset(body_parts):
            raise ValueError("bonded regions must be selected by fea.body")
        joined = set().union(*(cluster for cluster in clusters if cluster & selected))
        clusters = [cluster for cluster in clusters if not cluster & selected] + [joined]
    point_blocks, cell_blocks, face_blocks, aliases = [], [], [], []
    cell_roots, root_names, quality = [], [], []
    for cluster in sorted(clusters, key=lambda value: sorted(value)):
        sources = {key[0] for key in cluster}
        if len(sources) != 1:
            raise ValueError("bonded bodies must belong to the same Geometry scene")
        source = next(iter(sources))
        root_ids = sorted(key[1] for key in cluster)
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        mesh = await invocation.geometry.volume_mesh(invocation.world[source], root_ids, "m", profile, progress=invocation.progress)
        offset = sum(len(block) for block in point_blocks)
        point_blocks.append(mesh.points)
        cell_blocks.append(mesh.cells + offset)
        face_blocks.append(mesh.boundary_faces + offset)
        aliases.extend(tuple((source, p.root_id, p.source_node_id, p.surface_index) for p in provenance) for provenance in mesh.boundary_provenance)
        for region_index in mesh.cell_region_ids:
            key = (source, mesh.region_ids[int(region_index)])
            if key not in root_names:
                root_names.append(key)
            cell_roots.append(root_names.index(key))
        quality.append(mesh.quality)
    points = np.concatenate(point_blocks)
    cells = np.concatenate(cell_blocks)
    faces = np.concatenate(face_blocks)
    cell_roots = np.asarray(cell_roots, dtype=np.int32)
    model = StructuralModel(np.arange(len(points), dtype=np.int64), points, [], np.empty(0, dtype=int), np.empty(0, dtype=int), np.zeros((len(points), 6)), physical_node_count=len(points))
    material_frames = {}
    for rule in config["initializations"]:
        if rule["methodId"] == "fea.material-frame":
            for target in rule["target"]:
                source, _, group = target.split(".", 2)
                for part in geometry_parts(invocation.world[source], group):
                    material_frames[source, part["id"]] = np.asarray(parameter(rule["parameters"]["axes"]), dtype=float)
    materials = {}
    for key, part in body_parts.items():
        material, _ = selected_material(invocation, part_rules[key], "bodyDomain", part)
        if key in material_frames:
            material["C"] = orient_elasticity(material["C"], material_frames[key])
        materials[key] = material
    for index, nodes in enumerate(cells):
        key = root_names[int(cell_roots[index])]
        model.elements.append(Element("tet4", nodes, materials[key], {}, key[1]))
    for source in {key[0] for key in body_parts}:
        scene = invocation.world[source]
        for group in scene["geometryGroups"]:
            target = f"{source}.geometry.{group['name']}"
            indices = np.asarray([i for i, region in enumerate(cell_roots) if root_names[int(region)][0] == source and root_names[int(region)][1] in group["rootIds"]], dtype=int)
            if len(indices):
                model.cell_regions[target] = indices
        for group in scene["surfaceGroups"]:
            selectors = {(source, p["rootId"], p["sourceNodeId"], p["surfaceIndex"]) for p in group["selectors"]}
            face_indices = np.asarray([i for i, provenance in enumerate(aliases) if selectors.intersection(provenance)], dtype=int)
            # A bonded facet has one mesh face but two semantic material sides.
            # Geometry stores outward winding for its first provenance alias;
            # the other side must reverse it for pressure/contact normals.
            selected_faces = np.asarray([
                faces[index] if side == 0 else faces[index, [0, 2, 1]]
                for index in face_indices for side, alias in enumerate(aliases[index])
                if alias in selectors
            ], dtype=int).reshape(-1, 3)
            if not len(selected_faces):
                continue
            triangles = points[selected_faces]
            area = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
            target = f"{source}.surface.{group['name']}"
            nodes, inverse = np.unique(selected_faces.ravel(), return_inverse=True)
            weights = np.zeros(len(nodes))
            np.add.at(weights, inverse, np.repeat(area / 3, 3))
            region_roots = sorted({alias[1] for index in face_indices for alias in selectors.intersection(aliases[index])})
            model.boundary_regions[target] = {"faces": selected_faces, "nodes": nodes, "weights": weights / area.sum(), "area": float(area.sum()), "rootId": region_roots[0], "rootIds": region_roots, "referencePoint": np.average(triangles.mean(axis=1), weights=area, axis=0)}
    active = set((6 * np.arange(len(points))[:, None] + np.arange(3)).ravel())
    references = {}
    for rule in config["initializations"]:
        method = rule["methodId"]
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        targets = rule["target"]
        if method in ("fea.rigid-connection", "fea.revolute"):
            a, b = (attachment(model, target, references, active) for target in targets)
            components = np.arange(6)
            if method == "fea.revolute":
                components = np.asarray([component for component in range(6) if component != 3 + "xyz".index(p["axis"])])
            model.links.append((a, b, components))
        elif method in ("fea.translation-spring", "fea.rotation-spring"):
            offset = 3 if method == "fea.rotation-spring" else 0
            a = 6 * attachment(model, targets[0], references, active) + offset + "xyz".index(p["axisA"])
            b = -1 if len(targets) == 1 else 6 * attachment(model, targets[1], references, active) + offset + "xyz".index(p["axisB"])
            if min(p["stiffness"], p["damping"]) < 0:
                raise ValueError("spring stiffness and damping must be nonnegative")
            model.springs.append((a, b, float(p["ratio"]), float(p["stiffness"]), float(p["damping"])))
        elif method == "fea.rotor":
            if any(len(surface_region(model, target)["rootIds"]) != 1 for target in targets):
                raise ValueError("each rotor attachment must identify one CSG body")
            nacelle, hub, generator, *blades = [attachment(model, target, references, active) for target in targets]
            if p["gearRatio"] <= 0:
                raise ValueError("rotor gearRatio must be positive")
            model.links.extend((nacelle, node, np.array([0, 1, 2, 4, 5])) for node in (hub, generator))
            model.links.extend((hub, node, np.arange(6)) for node in blades)
            blade_nodes = []
            for target in targets[3:]:
                root_id = surface_region(model, target)["rootId"]
                blade_nodes.append(np.unique(np.concatenate([element.nodes for element in model.elements if element.root_id == root_id])))
            model.rotor = {**p, "nacelleNode": nacelle, "hubNode": hub, "generatorNode": generator, "bladeRootNodes": np.asarray(blades, dtype=int), "bladeNodeIds": blade_nodes, "axis": np.array([1., 0., 0.])}
            for name, target in (("hubBodyNodes", targets[1]), ("generatorBodyNodes", targets[2])):
                root_id = surface_region(model, target)["rootId"]
                model.rotor[name] = np.unique(np.concatenate([element.nodes for element in model.elements if element.root_id == root_id]))
            model.springs.append((6 * hub + 3, 6 * generator + 3, 1 / p["gearRatio"], p["shaftStiffness"], p["shaftDamping"]))
    fixed, support_nodes, load_points, load_vectors = set(), set(), [], []
    for rule in config["boundaryConditions"]:
        method = rule["methodId"]
        p = {key: parameter(value) for key, value in rule["parameters"].items()}
        if method == "fea.gravity":
            model.gravity = np.asarray(p["acceleration"], dtype=float)
            continue
        if method == "fea.contact":
            slave, master = (surface_region(model, target) for target in rule["target"])
            if p["penalty"] <= 0:
                raise ValueError("contact penalty must be positive")
            model.contacts.append({"slaveFaces": slave["faces"], "masterFaces": master["faces"], "penalty": float(p["penalty"])})
            continue
        for target in rule["target"]:
            region = surface_region(model, target)
            if method == "fea.fixed":
                components = ["xyz".index(component) for component in p["components"]]
                if target in references:
                    if set(components) != {0, 1, 2}:
                        raise ValueError("an attached support patch must be fully fixed; use a revolute connection for a hinge")
                    fixed.update(range(6 * references[target], 6 * references[target] + 6))
                else:
                    fixed.update(6 * int(node) + component for node in region["nodes"] for component in components)
                support_nodes.update(map(int, region["nodes"]))
            elif method in ("fea.surface-load", "fea.traction", "fea.pressure"):
                if method == "fea.surface-load":
                    nodes, values = distribute_resultant(model.points, region["faces"], np.asarray(p["force"]), np.asarray(p["moment"]), np.asarray(p["referencePoint"]))
                    np.add.at(model.force[:, :3], nodes, values)
                    load_points.append(region["referencePoint"])
                    load_vectors.append(np.asarray(p["force"]))
                else:
                    triangles = model.points[region["faces"]]
                    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]) / 2
                    resultant = -float(p["pressure"]) * normals if method == "fea.pressure" else np.linalg.norm(normals, axis=1)[:, None] * np.asarray(p["traction"])
                    np.add.at(model.force[:, :3], region["faces"].ravel(), np.repeat(resultant / 3, 3, axis=0))
                    load_points.extend(triangles.mean(axis=1))
                    load_vectors.extend(resultant)
            elif method != "fea.resultant-transfer":
                raise ValueError(f"unsupported CSG boundary condition {method!r}")
    model.active = np.asarray(sorted(active), dtype=int)
    model.fixed = np.asarray(sorted(fixed), dtype=int)
    dependent = {6 * slave + int(component) for _, slave, components in model.links for component in components}
    if fixed & dependent:
        raise ValueError("support overlaps a dependent attachment; use its complete attachment surface group")
    if bool(parameters["geometricNonlinear"]):
        joints = revolute_joints(model)
        slaves = {slave for _, slave, _ in model.links}
        for a, b, ratio, stiffness, _ in model.springs:
            if stiffness == 0:
                continue
            for dof in (a, b if ratio != 0 else -1):
                if dof < 0 or dof % 6 < 3:
                    continue
                node, component = divmod(dof, 6)
                joint_angle = node in joints and component == 3 + joints[node][1]
                fixed_axis = node not in slaves and all(6 * node + other in fixed for other in range(3, 6) if other != component)
                if not joint_angle and not fixed_axis:
                    raise ValueError("finite-rotation spring requires a revolute joint coordinate or an independent fixed-axis attachment")
    model.provenance = {source: invocation.world[source]["geometryHash"] for source in ("experiment", "task") if source in invocation.world}
    model.provenance.update({"representation": "csg-tet4-v2", "spatialResolution": resolution, "physicalNodeCount": len(points), "boundaryFaces": faces.astype(np.int32), "cellRegions": cell_roots, "regionIds": [f"{source}:{root}" for source, root in root_names], "supportNodes": np.asarray(sorted(support_nodes), dtype=np.int32), "loadPoints": np.asarray(load_points, dtype=float).reshape(-1, 3), "loadVectors": np.asarray(load_vectors, dtype=float).reshape(-1, 3), "auxiliaryNodes": dict(references)})
    model.provenance["elementBlocks"] = [{"methodId": "fea.body", "target": part_rules[key]["target"], "rootId": key[1], "cellType": "tet4", "elementIds": np.flatnonzero(cell_roots == index).astype(np.int32)} for index, key in enumerate(root_names)]
    model.provenance["quality"] = {"cellVolumes": np.concatenate([item.cell_volumes for item in quality]), "meanRatios": np.concatenate([item.mean_ratios for item in quality])}
    model.provenance["boundaryProvenance"] = {
        "offsets": np.r_[0, np.cumsum([len(group) for group in aliases])].astype(np.int32),
        "sources": [alias[0] for group in aliases for alias in group],
        "rootIds": [alias[1] for group in aliases for alias in group],
        "sourceNodeIds": [alias[2] for group in aliases for alias in group],
        "surfaceIndices": np.asarray([alias[3] for group in aliases for alias in group], dtype=np.int32),
    }
    for output in config["outputs"]:
        model.result_requests[output["key"]] = {"regions": list(output["target"]), **{key: parameter(value) for key, value in output.get("parameters", {}).items()}}
    fingerprint = hashlib.sha256(b"structural-mechanics-model-v2")
    update_fingerprint(fingerprint, (model.points, cells, config, model.provenance, [(e.material, e.root_id) for e in model.elements]))
    model.identity = fingerprint.hexdigest()
    return model
