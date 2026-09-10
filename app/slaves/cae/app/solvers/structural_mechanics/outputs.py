"""수치 배열을 기존 ABI 값으로 포장한다. 물리량마다 단위를 분리한다."""

import hashlib

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue

from .continuum import element_response, integration_points, physical_rotation_vectors
from .domain import distribute_resultant, parameter
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
        request = model.result_requests.get(output.get("key", ""))
        if request is not None and request.get("regions"):
            for name in request["regions"]:
                if name not in model.boundary_regions:
                    raise ValueError(f"history target {name!r} is not a structural surface region")
                for index in model.boundary_regions[name]["nodes"]:
                    if int(index) not in selected:
                        selected.append(int(index))
            continue
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


def _region_history_members(model, solution, regions, scope, complete):
    """Area-average kinematics and sum reaction resultants for surface regions."""
    members = {"regionIds": np.asarray(regions, dtype=str)}
    nodal = {"displacement", "rotation", "velocity", "reaction", "reactionMoment"}
    stored_nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    lookup = {int(node): index for index, node in enumerate(stored_nodes)}
    selections = []
    for name in regions:
        region = model.boundary_regions[name]
        nodes = np.asarray(region["nodes"], dtype=int)
        columns = np.asarray([lookup[int(node)] for node in nodes], dtype=int)
        weights = np.asarray(region["weights"], dtype=float)
        selections.append((region, nodes, columns, weights))
    chunk_indices = range(len(next(iter(solution.history.values()), ())))
    if scope == "latest-window" and solution.history:
        chunk_indices = range(len(next(iter(solution.history.values()))) - 1, len(next(iter(solution.history.values()))))
    for name, chunks in solution.history.items():
        if scope == "final" and not complete:
            shape = (0, len(regions), 3) if name in nodal else (0,)
            members[name] = np.empty(shape, dtype=float)
            continue
        if name not in nodal:
            chosen = [np.asarray(chunks[index]) for index in chunk_indices]
            members[name] = np.concatenate(chosen, axis=0)
            continue
        values = []
        for index in chunk_indices:
            chunk = np.asarray(chunks[index])
            region_values = []
            for region, nodes, columns, weights in selections:
                if name in ("displacement", "rotation", "velocity"):
                    region_values.append(np.einsum("n,sni->si", weights, chunk[:, columns]))
                elif name == "reaction":
                    region_values.append(chunk[:, columns].sum(axis=1))
                else:
                    reactions = np.asarray(solution.history["reaction"][index])[:, columns]
                    translations = np.asarray(solution.history["displacement"][index])[:, columns]
                    positions = model.points[nodes][None] + translations
                    reference = np.asarray(region["referencePoint"], dtype=float)
                    moment = chunk[:, columns].sum(axis=1) + np.cross(positions - reference, reactions).sum(axis=1)
                    region_values.append(moment)
            values.append(np.stack(region_values, axis=1))
        members[name] = np.concatenate(values, axis=0)
    return members


def history_members(model, solution, node_ids=None, scope="cumulative", complete=True, regions=None):
    """요청한 범위에서만 이력 조각을 펼쳐 공개 tensor를 만듭니다.

    final은 마지막 연성 구간이 수렴하기 전까지 sample 축 길이가 0입니다.
    따라서 중간 trial마다 과거 전체 배열을 다시 만드는 비용이 없습니다.
    latest-window는 최근 구간에서 기록한 표본만, cumulative는 t=0부터의
    모든 표본을 반환합니다. nodeIds는 배열 열과 실제 모델 절점을 연결합니다.
    """
    if regions is not None:
        return _region_history_members(model, solution, regions, scope, complete)
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


def interface_metadata(model):
    """Semantic physical regions and their optional opaque attachment IDs."""
    return {
        "regions": {
            name: model.node_ids[np.asarray(region["nodes"], dtype=int)].astype(np.int32)
            for name, region in model.boundary_regions.items()
        },
        "regionReferences": {
            target: int(model.node_ids[int(node)])
            for target, node in model.provenance.get("auxiliaryNodes", {}).items()
        },
    }


def physical_support_reactions(model, reaction, displacement):
    """Map fixed attachment wrenches back to their physical surface nodes.

    The numerical constraint owns six support reactions at an auxiliary
    reference node.  Public physical fields and semantic surface histories do
    not expose that solver-created node, so its wrench is conservatively
    distributed on the current attachment patch without changing the solved
    reaction array.
    """
    result = np.asarray(reaction).copy()
    physical_count = getattr(model, "physical_node_count", None)
    if physical_count is None:
        return result
    fixed = set(map(int, model.fixed))
    current = model.points + np.asarray(displacement)[:, :3]
    for target, node in model.provenance.get("auxiliaryNodes", {}).items():
        node = int(node)
        if target not in model.boundary_regions or not all(6 * node + component in fixed for component in range(6)):
            continue
        region = model.boundary_regions[target]
        nodes, forces = distribute_resultant(
            current, np.asarray(region["faces"], dtype=int), result[node, :3],
            result[node, 3:], current[node],
        )
        np.add.at(result[:, :3], nodes, forces)
    return result


def _physical_domain(model, selected_elements=None):
    """Build a physical result mesh, optionally restricted to element rows."""
    physical_count = len(model.points) if model.physical_node_count is None else int(model.physical_node_count)
    selected = None if selected_elements is None else set(map(int, np.asarray(selected_elements).ravel()))
    grouped = {}
    for index, element in enumerate(model.elements):
        if np.any(element.nodes >= physical_count) or (selected is not None and index not in selected):
            continue
        grouped.setdefault(element.kind, []).append((index, element.nodes))
    if selected is not None and len(selected) != sum(len(entries) for entries in grouped.values()):
        raise ValueError("result geometry target contains a nonphysical or absent element")
    order = [index for entries in grouped.values() for index, _ in entries]
    if selected is not None and not order:
        raise ValueError("result geometry target contains no physical cells")
    used_nodes = np.arange(physical_count, dtype=int) if selected is None else (
        np.unique(np.concatenate([nodes for entries in grouped.values() for _, nodes in entries]))
        if grouped else np.arange(physical_count, dtype=int)
    )
    node_map = np.full(physical_count, -1, dtype=int)
    node_map[used_nodes] = np.arange(len(used_nodes))
    blocks = {}
    for kind, entries in grouped.items():
        blocks[kind] = node_map[np.asarray([nodes for _, nodes in entries])].astype(np.int32)
    if model.physical_node_count is None:
        for contact in model.contacts:
            if "faces" in contact:
                blocks.setdefault("contact-tri3", []).extend(contact["faces"])
        if "contact-tri3" in blocks and not isinstance(blocks["contact-tri3"], np.ndarray):
            blocks["contact-tri3"] = np.asarray(blocks["contact-tri3"], dtype=np.int32)
    if not blocks:
        blocks["vertex"] = np.arange(len(used_nodes), dtype=np.int32).reshape(-1, 1)

    provenance = dict(model.provenance)
    provenance["physicalNodeCount"] = len(used_nodes)
    original_faces = np.asarray(model.provenance.get("boundaryFaces", np.empty((0, 3))), dtype=int).reshape(-1, 3)
    if selected is None:
        face_indices = np.arange(len(original_faces))
    else:
        cell_faces = set()
        for index in order:
            nodes = model.elements[index].nodes
            if len(nodes) == 4:
                cell_faces.update(tuple(sorted(nodes[choice])) for choice in (
                    [0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2],
                ))
        face_indices = np.asarray([
            index for index, face in enumerate(original_faces)
            if tuple(sorted(map(int, face))) in cell_faces
        ], dtype=int)
    boundary_faces = original_faces[face_indices]
    provenance["boundaryFaces"] = (
        node_map[boundary_faces].astype(np.int32)
        if len(boundary_faces) else np.empty((0, 3), dtype=np.int32)
    )
    if "boundaryProvenance" in model.provenance:
        original = model.provenance["boundaryProvenance"]
        offsets = np.asarray(original["offsets"], dtype=int)
        groups = [np.arange(offsets[index], offsets[index + 1]) for index in face_indices]
        aliases = np.concatenate(groups) if groups else np.empty(0, dtype=int)
        provenance["boundaryProvenance"] = {
            "offsets": np.r_[0, np.cumsum([len(group) for group in groups])].astype(np.int32),
            "sources": np.asarray(original["sources"])[aliases],
            "rootIds": np.asarray(original["rootIds"])[aliases],
            "sourceNodeIds": np.asarray(original["sourceNodeIds"])[aliases],
            "surfaceIndices": np.asarray(original["surfaceIndices"], dtype=np.int32)[aliases],
        }
    if "cellRegions" in model.provenance:
        original_regions = np.asarray(model.provenance["cellRegions"], dtype=int)[order]
        retained_regions = np.unique(original_regions)
        region_lookup = {int(region): index for index, region in enumerate(retained_regions)}
        provenance["cellRegions"] = np.asarray([region_lookup[int(region)] for region in original_regions], dtype=np.int32)
        provenance["regionIds"] = np.asarray(model.provenance["regionIds"])[retained_regions]
    if "quality" in model.provenance:
        provenance["quality"] = {
            name: np.asarray(values)[order]
            for name, values in model.provenance["quality"].items()
        }
    if "supportNodes" in model.provenance:
        supports = np.asarray(model.provenance["supportNodes"], dtype=int)
        supports = supports[(supports >= 0) & (supports < physical_count)]
        provenance["supportNodes"] = node_map[supports[node_map[supports] >= 0]].astype(np.int32)
    if "elementBlocks" in model.provenance:
        element_lookup = {element: index for index, element in enumerate(order)}
        provenance["elementBlocks"] = [
            {**block, "elementIds": np.asarray([
                element_lookup[int(index)] for index in block["elementIds"] if int(index) in element_lookup
            ], dtype=np.int32)}
            for block in model.provenance["elementBlocks"]
            if any(int(index) in element_lookup for index in block["elementIds"])
        ]
    identity = model.identity
    if selected is not None and order != list(range(len(model.elements))):
        digest = hashlib.sha256(model.identity.encode("utf-8"))
        digest.update(np.asarray(order, dtype="<i8").tobytes())
        identity = digest.hexdigest()
    metadata = {
        "provenance": provenance,
        "nodeIds": model.node_ids[used_nodes],
        "nodeSets": model.node_sets,
        "faceSets": model.face_sets,
    }
    for name in (
        "boundaryFaces", "cellRegions", "regionIds", "supportNodes", "loadPoints",
        "loadVectors", "quality", "boundaryProvenance",
    ):
        if name in provenance:
            metadata[name] = provenance[name]
    if model.boundary_regions:
        metadata["boundaryRegions"] = {
            name: np.intersect1d(
                model.node_ids[np.asarray(region["nodes"], dtype=int)], model.node_ids[used_nodes],
            )
            for name, region in model.boundary_regions.items()
        }
    domain = UnstructuredMeshValue(model.points[used_nodes], blocks, "m", identity, metadata)
    return domain, order


def _region_resultants(model, solution, request):
    regions = request.get("regions", ())
    identifiers, references, forces, moments = [], [], [], []
    current = model.points + solution.displacement[:, :3]
    reaction = physical_support_reactions(model, solution.reaction, solution.displacement)
    for name in regions:
        if name not in model.boundary_regions:
            raise ValueError(f"result target {name!r} is not a structural surface region")
        region = model.boundary_regions[name]
        nodes = np.asarray(region["nodes"], dtype=int)
        reference = np.asarray(request.get("referencePoint", region["referencePoint"]), dtype=float)
        nodal_force = reaction[nodes, :3]
        force = nodal_force.sum(axis=0)
        moment = reaction[nodes, 3:].sum(axis=0)
        moment += np.cross(current[nodes] - reference, nodal_force).sum(axis=0)
        identifiers.append(name)
        references.append(reference)
        forces.append(force)
        moments.append(moment)
    return {
        "regionIds": np.asarray(identifiers, dtype=str),
        "referencePoints": np.asarray(references, dtype=float).reshape(-1, 3),
        "force": np.asarray(forces, dtype=float).reshape(-1, 3),
        "moment": np.asarray(moments, dtype=float).reshape(-1, 3),
    }


def _stress_tensor(values):
    values = np.asarray(values)
    return np.array([
        [values[0], values[3], values[5]],
        [values[3], values[1], values[4]],
        [values[5], values[4], values[2]],
    ])


def _tet_stress(model, solution, index):
    element = model.elements[index]
    result = solution.stresses[index]
    if result is None:
        result = element_response(
            "tet4", model.points[element.nodes],
            solution.displacement[element.nodes, :3].ravel(), element.material["C"],
        )[1]
    values = np.asarray(result)
    if values.ndim != 2 or values.shape[1] != 6:
        raise ValueError("solid resultants require six-component tet4 stress")
    return _stress_tensor(values.mean(axis=0))


def _tet_plane_triangles(reference, displacement, origin, normal):
    """Current triangles of a material tet's intersection with a reference plane."""
    distances = (reference - origin) @ normal
    scale = max(np.max(np.linalg.norm(reference - reference.mean(axis=0), axis=1)), 1.)
    tolerance = 64 * np.finfo(float).eps * scale
    positive, negative = distances > tolerance, distances < -tolerance
    on_plane = np.abs(distances) <= tolerance
    barycentric = [np.eye(4)[index] for index in np.flatnonzero(on_plane)]
    if np.any(positive) and np.any(negative):
        for first in range(4):
            for second in range(first + 1, 4):
                if distances[first] * distances[second] < -tolerance**2:
                    fraction = distances[first] / (distances[first] - distances[second])
                    value = np.zeros(4)
                    value[first], value[second] = 1 - fraction, fraction
                    barycentric.append(value)
    elif np.count_nonzero(on_plane) < 3 or not np.any(negative):
        # A plane coincident with a shared face belongs to its negative side.
        return []
    unique = []
    for value in barycentric:
        if not any(np.linalg.norm(value - previous) <= 1e-12 for previous in unique):
            unique.append(value)
    if len(unique) < 3:
        return []
    barycentric = np.asarray(unique)
    plane_points = barycentric @ reference
    center = plane_points.mean(axis=0)
    first = plane_points[np.argmax(np.linalg.norm(plane_points - center, axis=1))] - center
    first /= np.linalg.norm(first)
    second = np.cross(normal, first)
    angles = np.arctan2((plane_points - center) @ second, (plane_points - center) @ first)
    barycentric = barycentric[np.argsort(angles)]
    current_nodes = reference + displacement
    current_points = barycentric @ current_nodes
    gradients = integration_points("tet4", reference)[0][3]
    deformation = current_nodes.T @ gradients
    current_normal = np.linalg.solve(deformation.T, normal)
    current_normal /= np.linalg.norm(current_normal)
    triangles = []
    for index in range(1, len(current_points) - 1):
        triangle = current_points[[0, index, index + 1]]
        if np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0]) @ current_normal < 0:
            triangle = triangle[[0, 2, 1]]
        triangles.append(triangle)
    return triangles


def _section_resultants(model, solution, request):
    origin = np.asarray(request["origin"], dtype=float)
    normal = np.asarray(request["normal"], dtype=float)
    magnitude = np.linalg.norm(normal)
    if magnitude == 0:
        raise ValueError("section normal must be nonzero")
    normal = normal / magnitude
    reference_point = np.asarray(request.get("referencePoint", origin), dtype=float)
    regions = request.get("regions", ())
    identifiers, forces, moments = [], [], []
    for name in regions:
        if name not in model.cell_regions:
            raise ValueError(f"section target {name!r} is not a structural volume region")
        force, moment = np.zeros(3), np.zeros(3)
        for element_index in np.asarray(model.cell_regions[name], dtype=int):
            element = model.elements[int(element_index)]
            if element.kind != "tet4":
                continue
            stress = _tet_stress(model, solution, int(element_index))
            triangles = _tet_plane_triangles(
                model.points[element.nodes], solution.displacement[element.nodes, :3], origin, normal,
            )
            for triangle in triangles:
                area_vector = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0]) / 2
                traction = stress @ area_vector
                force += traction
                moment += np.cross(triangle.mean(axis=0) - reference_point, traction)
        identifiers.append(name)
        forces.append(force)
        moments.append(moment)
    return {
        "regionIds": np.asarray(identifiers, dtype=str),
        "referencePoints": np.tile(reference_point, (len(identifiers), 1)),
        "normals": np.tile(normal, (len(identifiers), 1)),
        "force": np.asarray(forces).reshape(-1, 3),
        "moment": np.asarray(moments).reshape(-1, 3),
    }


def build_outputs(config, descriptor, model, solution, motion=None, *, history_complete=True):
    domain, cell_order = _physical_domain(model)
    physical_count = len(model.points) if model.physical_node_count is None else int(model.physical_node_count)
    interface = interface_members(model)
    artifacts = {}
    for output in config["outputs"]:
        method, key = output["methodId"], output["key"]
        definition = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == method)
        data = definition["data"]
        request = model.result_requests.get(key, {})
        if method in ("fea.displacement", "fea.rotation", "fea.reaction") or (method == "fea.reaction-moment" and not request.get("regions")):
            rotations = physical_rotation_vectors(model, solution.displacement, solution.orientations)
            values = {
                "fea.displacement": solution.displacement[:physical_count, :3],
                "fea.rotation": rotations[:physical_count],
                "fea.reaction": physical_support_reactions(
                    model, solution.reaction, solution.displacement,
                )[:physical_count, :3],
                "fea.reaction-moment": solution.reaction[:physical_count, 3:],
            }[method]
            artifacts[key] = FieldValue(domain, "node", data["quantityKind"], data["unit"], values, data.get("basis"), ("x", "y", "z"))
            continue
        if method == "fea.stress-field":
            stress_domain, stress_order = domain, cell_order
            if request.get("regions"):
                selected = []
                for name in request["regions"]:
                    if name not in model.cell_regions:
                        raise ValueError(f"stress-field target {name!r} is not a structural volume region")
                    selected.extend(np.asarray(model.cell_regions[name], dtype=int))
                stress_domain, stress_order = _physical_domain(model, np.unique(selected))
            values = []
            for index in stress_order:
                if model.elements[index].kind != "tet4":
                    raise ValueError("stress-field currently requires a tet4 physical mesh")
                stress = _tet_stress(model, solution, index)
                values.append([stress[0, 0], stress[1, 1], stress[2, 2], stress[0, 1], stress[1, 2], stress[0, 2]])
            artifacts[key] = FieldValue(
                stress_domain, "cell", data["quantityKind"], data["unit"], np.asarray(values, dtype=float),
                data.get("basis"), ("xx", "yy", "zz", "xy", "yz", "xz"),
            )
            continue
        if method == "fea.interface":
            artifacts[key] = BundleValue(
                "caemble.mechanics/interface@1", interface, interface_metadata(model),
            )
            continue
        if method == "fea.motion":
            if motion is None:
                raise ValueError("motion waveform output requires transient analysis")
            artifacts[key] = motion
            continue
        if method == "fea.history":
            parameters = output.get("parameters", {})
            scope = parameter(parameters.get("scope", "cumulative"))
            if request.get("regions"):
                members = history_members(model, solution, scope=scope, complete=history_complete, regions=request["regions"])
            else:
                node_ids = parameter(parameters.get("nodeIds", model.node_ids))
                members = history_members(model, solution, node_ids, scope, history_complete)
        elif method == "fea.modes":
            modes = solution.spectrum["modes"]
            rotations = modes[:, :, 3:]
            if model.physical_node_count is not None:
                identity = np.tile(np.eye(3), (len(model.points), 1, 1))
                rotations = np.asarray([physical_rotation_vectors(model, mode, identity, linear=True) for mode in modes])
            members = {"frequencies": solution.spectrum["frequencies"], "displacement": modes[:, :physical_count, :3], "rotation": rotations[:, :physical_count]}
        elif method == "fea.buckling":
            modes = solution.spectrum["modes"]
            rotations = modes[:, :, 3:]
            if model.physical_node_count is not None:
                identity = np.tile(np.eye(3), (len(model.points), 1, 1))
                rotations = np.asarray([physical_rotation_vectors(model, mode, identity, linear=True) for mode in modes])
            members = {"factors": solution.spectrum["factors"], "displacement": modes[:, :physical_count, :3], "rotation": rotations[:, :physical_count]}
        elif method == "fea.harmonic":
            value = solution.spectrum["response"]
            rotations = value[:, :, 3:]
            if model.physical_node_count is not None:
                identity = np.tile(np.eye(3), (len(model.points), 1, 1))
                rotations = np.asarray([physical_rotation_vectors(model, response, identity, linear=True) for response in value])
            members = {"frequencies": solution.spectrum["frequencies"], "displacementReal": value[:, :physical_count, :3].real.copy(), "displacementImag": value[:, :physical_count, :3].imag.copy(), "rotationReal": rotations[:, :physical_count].real.copy(), "rotationImag": rotations[:, :physical_count].imag.copy()}
        elif method == "fea.reaction-moment":
            members = _region_resultants(model, solution, request)
        elif method == "fea.section-forces":
            if request.get("regions") and "origin" in request:
                members = _section_resultants(model, solution, request)
            else:
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
        coordinates = {"node": (members.get("nodeIds", model.node_ids[:physical_count]), None)}
        if "regionIds" in members:
            coordinates["region"] = (members["regionIds"], None)
        if method == "fea.history":
            coordinates["sample"] = (members["times"], "s")
        if method == "fea.harmonic":
            coordinates["frequency"] = (members["frequencies"], "Hz")
        if method == "fea.section-forces" and "regionIds" not in members:
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
