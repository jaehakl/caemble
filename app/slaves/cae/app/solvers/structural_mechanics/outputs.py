"""수치 배열을 기존 ABI 값으로 포장한다. 물리량마다 단위를 분리한다."""

import hashlib

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue

from .continuum import element_response, integration_points, physical_rotation_vectors
from .domain import distribute_resultant, parameter


def configure_history(model, outputs):
    """Accepted physical-node history also supplies the automatic deformation viewer."""
    count = len(model.points) if model.physical_node_count is None else model.physical_node_count
    model.history_nodes = np.arange(count, dtype=int)


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
    if len(np.unique(requested)) != len(requested):
        raise ValueError("History node IDs must be unique")
    if any(int(node) not in lookup for node in requested):
        raise ValueError("History must contain every physical mesh node; requested IDs are absent")
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


def build_outputs(config, descriptor, model, solution, motion=None):
    from app.methods.fields.box_grid import BoxGrid, TetrahedralSampler, pack_box_grid

    domain, cell_order = _physical_domain(model)
    count = len(domain.points)
    cells = np.asarray([model.elements[index].nodes for index in cell_order], dtype=int)
    rotations = physical_rotation_vectors(model, solution.displacement, solution.orientations)
    stresses = np.asarray([_tet_stress(model, solution, index) for index in cell_order]).reshape(-1, 3, 3)
    compact = stresses[:, (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)]
    histories = history_members(model, solution, model.node_ids[:count])
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts, exports, visuals = {}, {}, {}
    samplers = {}
    for output in config["outputs"]:
        method = output["methodId"]
        data = definitions[method]["data"]
        grid = BoxGrid(output["boxGrid"])
        parameters = {key: parameter(value) for key, value in output.get("parameters", {}).items()}
        times, frequencies = [0.0], [0.0]
        scope = parameters.get("scope", "cumulative")
        if scope not in ("cumulative", "latest-window", "final"):
            raise ValueError("history scope must be cumulative, latest-window or final")
        history = history_members(model, solution, model.node_ids[:count],
                                  "cumulative" if scope == "final" else scope)
        if scope == "final":
            history = {name: value if name == "nodeIds" else value[-1:]
                       for name, value in history.items()}
        aggregate = data["boxGrid"]["sampling"] == "aggregate"
        if aggregate:
            if grid.shape != (1, 1, 1):
                raise ValueError(f"{method} requires gridShape [1, 1, 1]")
            if method == "fea.buckling-factor":
                index = int(parameters["modeIndex"]) - 1
                if index < 0 or index >= len(solution.spectrum["factors"]):
                    raise ValueError("modeIndex is one-based and must identify a solved buckling mode")
                sampled = solution.spectrum["factors"][index]
            elif method in ("fea.reaction", "fea.reaction-moment"):
                selected = grid.contains(model.points[:count])
                reactions = physical_support_reactions(model, solution.reaction, solution.displacement)[:count]
                if method == "fea.reaction":
                    sampled = reactions[selected, :3].sum(axis=0)
                else:
                    reference = np.asarray(parameters["referencePoint"])
                    positions = model.points[:count] + solution.displacement[:count, :3]
                    sampled = (reactions[selected, 3:] + np.cross(positions[selected] - reference, reactions[selected, :3])).sum(axis=0)
            elif method in ("fea.section-force", "fea.section-moment"):
                force, moment_value = _box_section_resultant(model, solution, grid, parameters)
                sampled = force if method == "fea.section-force" else moment_value
            else:
                names = {"fea.strain-energy-history": "strainEnergy", "fea.kinetic-energy-history": "kineticEnergy",
                         "fea.power-history": "power", "fea.generator-speed-history": "generatorSpeed",
                         "fea.generator-torque-history": "generatorTorque", "fea.rotor-speed-history": "rotorSpeed",
                         "fea.pitch-history": "pitch"}
                sampled = history[names[method]]
                times = history["times"]
        else:
            identity = (tuple(grid.geometry["origin"]), tuple(grid.geometry["size"]),
                        tuple(np.asarray(grid.geometry["rotation"]).ravel()), grid.shape)
            if identity not in samplers:
                samplers[identity] = TetrahedralSampler.prepare(model.points, cells, grid.points("m"))
            sampler = samplers[identity]
            location = "node"
            if method == "fea.displacement":
                values = solution.displacement[:, :3]
            elif method == "fea.rotation":
                values = rotations
            elif method == "fea.stress-field":
                values, location = compact, "cell"
            elif method in ("fea.plastic-strain", "fea.equivalent-plastic-strain"):
                name = "plasticStrain" if method == "fea.plastic-strain" else "equivalentPlasticStrain"
                shape = (6,) if name == "plasticStrain" else ()
                values = np.asarray([np.zeros(shape) if solution.element_history[index] is None else
                                     np.asarray(solution.element_history[index][name]).mean(axis=0)
                                     for index in cell_order])
                if name == "plasticStrain":
                    # The constitutive state stores engineering shear; public tensor components are epsilon_ij.
                    values[:, 3:] *= 0.5
                location = "cell"
            elif method in ("fea.displacement-history", "fea.rotation-history", "fea.velocity-history"):
                name = {"fea.displacement-history": "displacement", "fea.rotation-history": "rotation",
                        "fea.velocity-history": "velocity"}[method]
                values = np.moveaxis(history[name], 0, 1)
                times = history["times"]
            elif method in ("fea.modal-displacement", "fea.modal-rotation"):
                modes = solution.spectrum["modes"]
                if method.endswith("rotation"):
                    identity_frames = np.tile(np.eye(3), (len(model.points), 1, 1))
                    modes = np.asarray([physical_rotation_vectors(model, mode, identity_frames, linear=True) for mode in modes])
                else:
                    modes = modes[:, :, :3]
                values = np.moveaxis(modes, 0, 1)
                frequencies = solution.spectrum["frequencies"]
            elif method in ("fea.harmonic-displacement", "fea.harmonic-rotation"):
                response = solution.spectrum["response"]
                if method.endswith("rotation"):
                    identity_frames = np.tile(np.eye(3), (len(model.points), 1, 1))
                    response = np.asarray([physical_rotation_vectors(model, item, identity_frames, linear=True) for item in response])
                else:
                    response = response[:, :, :3]
                values = np.moveaxis(response, 0, 1)
                frequencies = solution.spectrum["frequencies"]
            elif method in ("fea.buckling-displacement", "fea.buckling-rotation"):
                index = int(parameters["modeIndex"]) - 1
                if index < 0 or index >= len(solution.spectrum["modes"]):
                    raise ValueError("modeIndex is one-based and must identify a solved buckling mode")
                mode = solution.spectrum["modes"][index]
                values = (physical_rotation_vectors(model, mode, np.tile(np.eye(3), (len(model.points), 1, 1)), linear=True)
                          if method.endswith("rotation") else mode[:, :3])
            else:
                raise ValueError(f"unsupported structural Box output {method!r}")
            sampled = sampler.sample(values, location=location)
        artifacts[output["key"]] = pack_box_grid(grid, data, sampled, times=times, frequencies=frequencies)

    for output in config.get("exports", ()):
        if output["methodId"] == "fea.interface":
            exports[output["key"]] = BundleValue("caemble.mechanics/interface@1", interface_members(model), interface_metadata(model))
        elif output["methodId"] == "fea.motion":
            if motion is None:
                raise ValueError("motion export requires transient analysis")
            exports[output["key"]] = motion
        else:
            raise ValueError(f"unsupported structural native export {output['methodId']!r}")
    for name, definition in descriptor.get("visualizations", {}).items():
        data = definition["data"]
        if name == "displacement":
            visuals[name] = FieldValue(domain, "node", data["quantityKind"], data["unit"], solution.displacement[:count, :3], data.get("basis"), ("x", "y", "z"))
        elif name == "stress":
            visuals[name] = FieldValue(domain, "cell", data["quantityKind"], data["unit"], compact, data.get("basis"), ("xx", "yy", "zz", "xy", "yz", "xz"))
        elif name == "displacementHistory" and parameter(config["parameters"]["analysis"]) == "transient":
            field_data = data["members"]["field"]
            field = FieldValue(domain, "node", field_data["quantityKind"], field_data["unit"], histories["displacement"][-1], field_data.get("basis"), ("x", "y", "z"))
            visuals[name] = BundleValue(definition["artifactType"], {
                "field": field,
                "times": {"value": histories["times"], "axes": [{"ticks": histories["times"]}]},
                "values": {"value": histories["displacement"], "axes": [{"ticks": histories["times"]}, {"ticks": model.node_ids[:count]}, {"implicitOrdinal": True}]},
            })
    return artifacts, exports, visuals


def _box_section_resultant(model, solution, grid, parameters):
    """Integrate the solved stress over a clipped, oriented section of the probe Box."""
    origin = np.asarray(parameters["origin"], dtype=float)
    normal = np.asarray(parameters["normal"], dtype=float)
    normal /= np.linalg.norm(normal)
    reference = np.asarray(parameters["referencePoint"], dtype=float)
    force, moment = np.zeros(3), np.zeros(3)
    from app.methods.fields.box_grid import clip_box_polygon
    for index, element in enumerate(model.elements):
        stress = _tet_stress(model, solution, index)
        triangles = _tet_plane_triangles(model.points[element.nodes], solution.displacement[element.nodes, :3], origin, normal)
        for triangle in triangles:
            world = clip_box_polygon(triangle, grid)
            for item in range(1, len(world) - 1):
                piece = world[[0, item, item + 1]]
                traction = stress @ (np.cross(piece[1] - piece[0], piece[2] - piece[0]) / 2)
                force += traction
                moment += np.cross(piece.mean(axis=0) - reference, traction)
    return force, moment
