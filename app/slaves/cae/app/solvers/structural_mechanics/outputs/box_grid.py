"""Sample solved structural fields and resultants on recorded Box Grids."""

import numpy as np

from ..continuum import physical_rotation_vectors
from ..domain import parameter
from ..interfaces.resultants import physical_support_reactions
from ..model import HarmonicSolution
from .fields import _physical_domain, _tet_stress, finite_deformation_fields
from .history import history_members
from .sections import _tet_plane_triangles
from ..solid_fields import sample_solid
from ..thermal import thermal_stress_at
from .thermal import surface_displacement_metrics, rms_von_mises_stress, thermal_section_resultant


def _box_section_resultant(model, solution, grid, parameters):
    """Integrate the solved stress over a clipped, oriented section of the probe Box."""
    if model.thermal_strain is not None:
        return thermal_section_resultant(model, solution, grid, parameters)
    origin = np.asarray(parameters["origin"], dtype=float)
    normal = np.asarray(parameters["normal"], dtype=float)
    normal /= np.linalg.norm(normal)
    reference = np.asarray(parameters["referencePoint"], dtype=float)
    force, moment = np.zeros(3), np.zeros(3)
    from app.methods.fields.box_grid import clip_box_polygon
    for index, element in enumerate(model.elements):
        if solution.bubble is not None:
            from .mixed_section import mini_section_resultant
            triangles = _tet_plane_triangles(model.points[element.nodes], np.zeros((4, 3)), origin, normal)
            part_force, part_moment = mini_section_resultant(model, solution, index, triangles, normal, reference, grid)
            force += part_force
            moment += part_moment
            continue
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


def build_box_outputs(config, descriptor, model, solution):
    from app.methods.fields.box_grid import BoxGrid, TetrahedralSampler, pack_box_grid

    domain, cell_order = _physical_domain(model)
    count = len(domain.points)
    cells = np.asarray([model.elements[index].nodes for index in cell_order], dtype=int)
    harmonic = isinstance(solution, HarmonicSolution)
    if harmonic:
        unsupported = [item["methodId"] for item in config["outputs"] if item["methodId"] not in ("fea.harmonic-displacement", "fea.harmonic-rotation")]
        if unsupported:
            raise ValueError(f"harmonic analysis requires harmonic Box Grid outputs, received {unsupported}")
    else:
        rotations = (physical_rotation_vectors(model, solution.displacement, solution.orientations)
                     if any(output["methodId"] == "fea.rotation" for output in config["outputs"]) else None)
        stresses = np.asarray([_tet_stress(model, solution, index) for index in cell_order]).reshape(-1, 3, 3)
        compact = stresses[:, (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)]
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts = {}
    samplers = {}
    deformation_fields = None
    for output in config["outputs"]:
        method = output["methodId"]
        data = definitions[method]["data"]
        method = method.replace("fea.current-", "fea.")
        grid = BoxGrid(output["boxGrid"])
        parameters = {key: parameter(value) for key, value in output.get("parameters", {}).items()}
        times, frequencies = [0.0], [0.0]
        scope = parameters.get("scope", "cumulative")
        history = {} if harmonic else history_members(model, solution, model.node_ids[:count], scope)
        aggregate = data["boxGrid"]["sampling"] == "aggregate"
        if aggregate:
            if grid.shape != (1, 1, 1):
                raise ValueError(f"{method} requires gridShape [1, 1, 1]")
            if method == "fea.strain-energy":
                sampled = solution.strain_energy
            elif method == "fea.equilibrium-energy":
                sampled = solution.equilibrium_energy
            elif method == "fea.buckling-factor":
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
            elif method in ("fea.maximum-normal-displacement", "fea.surface-warpage"):
                maximum, warpage = surface_displacement_metrics(model, solution, grid, parameters)
                sampled = maximum if method == "fea.maximum-normal-displacement" else warpage
            elif method == "fea.rms-von-mises-stress":
                sampled = rms_von_mises_stress(model, solution, grid)
            else:
                names = {"fea.strain-energy-history": "strainEnergy", "fea.kinetic-energy-history": "kineticEnergy",
                         "fea.power-history": "power", "fea.generator-speed-history": "generatorSpeed",
                         "fea.generator-torque-history": "generatorTorque", "fea.rotor-speed-history": "rotorSpeed",
                         "fea.pitch-history": "pitch"}
                sampled = history[names[method]]
                times = history["times"]
        else:
            identity = (tuple(grid.geometry["origin"]), tuple(grid.geometry["size"]),
                        tuple(np.asarray(grid.geometry["rotation"]).ravel()), grid.shape, data["boxGrid"].get("configuration", "reference"))
            if identity not in samplers:
                points = model.points
                if data["boxGrid"].get("configuration") == "current":
                    if harmonic:
                        raise ValueError("current configuration requires a static solution")
                    points = points + solution.displacement[:, :3]
                samplers[identity] = TetrahedralSampler.prepare(points, cells, grid.points("m"))
            sampler = samplers[identity]
            if method == "fea.stress-field" and model.thermal_strain is not None:
                sampled = np.zeros((len(sampler.cell_indices), 6))
                for cell in np.unique(sampler.cell_indices[sampler.cell_indices >= 0]):
                    selected = sampler.cell_indices == cell
                    sampled[selected] = thermal_stress_at(model, solution, cell_order[cell], sampler.barycentric[selected])
                artifacts[output["key"]] = pack_box_grid(grid, data, sampled.reshape((*sampler.shape, 6)))
                continue
            finite_method = {"fea.displacement": "displacement", "fea.stress-field": "cauchyStress",
                             "fea.volume-ratio": "volumeRatio", "fea.mean-pressure": "meanPressure"}
            if method in finite_method and (solution.bubble is not None or method == "fea.mean-pressure"):
                sampled = sample_solid(model, solution, sampler, grid.points("m"), finite_method[method], current=data["boxGrid"].get("configuration") == "current")
                if method == "fea.stress-field":
                    sampled = sampled[..., (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)]
                artifacts[output["key"]] = pack_box_grid(grid, data, sampled, times=times, frequencies=frequencies)
                continue
            location = "node"
            if method == "fea.displacement":
                values = solution.displacement[:, :3]
            elif method == "fea.rotation":
                values = rotations
            elif method == "fea.stress-field":
                values, location = compact, "cell"
            elif method == "fea.volume-ratio":
                if deformation_fields is None:
                    deformation_fields = finite_deformation_fields(model, solution)
                values, location = deformation_fields["volumeRatio"][cell_order], "cell"
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
                response = solution.complex_displacement
                if method.endswith("rotation"):
                    identity_frames = np.tile(np.eye(3), (len(model.points), 1, 1))
                    response = np.asarray([physical_rotation_vectors(model, item, identity_frames, linear=True) for item in response])
                else:
                    response = response[:, :, :3]
                values = np.moveaxis(response, 0, 1)
                frequencies = solution.frequencies
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

    return artifacts
