"""수치 배열을 기존 ABI 값으로 포장한다. 물리량마다 단위를 분리한다."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue

from .continuum import element_response, integration_points, physical_rotation_vectors
from .domain import distribute_resultant, parameter


def configure_history(model):
    """Accepted physical-node history also supplies the automatic deformation viewer."""
    count = len(model.points) if model.physical_node_count is None else model.physical_node_count
    model.history_nodes = np.arange(count, dtype=int)


def history_members(model, solution, node_ids=None, scope="cumulative"):
    """Flatten accepted samples; final selects the last sample of this invocation.

    latest-window selects the last accepted chunk. Automatic mesh visualization
    uses cumulative history independently of the requested Box Grid scope.
    """
    if scope not in ("cumulative", "latest-window", "final"):
        raise ValueError("history scope must be cumulative, latest-window or final")
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
        chunks = chunks[-1:] if scope in ("latest-window", "final") else chunks
        selected = [np.asarray(chunk)[:, selection] if name in nodal else np.asarray(chunk) for chunk in chunks]
        members[name] = selected[-1][-1:] if scope == "final" else np.concatenate(selected, axis=0)
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


def _physical_domain(model):
    """Build the complete physical mesh for automatic visualization."""
    physical_count = len(model.points) if model.physical_node_count is None else int(model.physical_node_count)
    grouped = {}
    for index, element in enumerate(model.elements):
        if np.any(element.nodes >= physical_count):
            continue
        grouped.setdefault(element.kind, []).append((index, element.nodes))
    order = [index for entries in grouped.values() for index, _ in entries]
    blocks = {}
    for kind, entries in grouped.items():
        blocks[kind] = np.asarray([nodes for _, nodes in entries], dtype=np.int32)
    if model.physical_node_count is None:
        for contact in model.contacts:
            if "faces" in contact:
                blocks.setdefault("contact-tri3", []).extend(contact["faces"])
        if "contact-tri3" in blocks and not isinstance(blocks["contact-tri3"], np.ndarray):
            blocks["contact-tri3"] = np.asarray(blocks["contact-tri3"], dtype=np.int32)
    if not blocks:
        blocks["vertex"] = np.arange(physical_count, dtype=np.int32).reshape(-1, 1)

    provenance = dict(model.provenance)
    provenance["physicalNodeCount"] = physical_count
    provenance["boundaryFaces"] = np.asarray(
        model.provenance.get("boundaryFaces", np.empty((0, 3))), dtype=np.int32,
    ).reshape(-1, 3)
    if "boundaryProvenance" in model.provenance:
        original = model.provenance["boundaryProvenance"]
        provenance["boundaryProvenance"] = {
            "offsets": np.asarray(original["offsets"], dtype=np.int32),
            "sources": np.asarray(original["sources"]),
            "rootIds": np.asarray(original["rootIds"]),
            "sourceNodeIds": np.asarray(original["sourceNodeIds"]),
            "surfaceIndices": np.asarray(original["surfaceIndices"], dtype=np.int32),
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
        provenance["supportNodes"] = supports.astype(np.int32)
    if "elementBlocks" in model.provenance:
        element_lookup = {element: index for index, element in enumerate(order)}
        provenance["elementBlocks"] = [
            {**block, "elementIds": np.asarray([
                element_lookup[int(index)] for index in block["elementIds"] if int(index) in element_lookup
            ], dtype=np.int32)}
            for block in model.provenance["elementBlocks"]
            if any(int(index) in element_lookup for index in block["elementIds"])
        ]
    metadata = {
        "provenance": provenance,
        "nodeIds": model.node_ids[:physical_count],
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
                model.node_ids[np.asarray(region["nodes"], dtype=int)], model.node_ids[:physical_count],
            )
            for name, region in model.boundary_regions.items()
        }
    domain = UnstructuredMeshValue(model.points[:physical_count], blocks, "m", model.identity, metadata)
    return domain, order


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
        history = history_members(model, solution, model.node_ids[:count], scope)
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
