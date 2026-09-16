"""Passive fluid-volume observations and native fields at the accepted window end."""

import numpy as np

from app.kernel.api import FieldValue, UnstructuredMeshValue
from app.methods.coupling.tetrahedral import TetrahedralBoxOverlap
from app.methods.fields.box_grid import BoxGrid, pack_box_grid

from .domain import parameter
from .surface_loads import (SurfaceBoxOverlap, SurfaceRecovery, load_settings, result_metadata,
                            select_surfaces, surface_observers, traction_field)


def build_outputs(invocation, domain, solution, *, samples=None, time=0.):
    definitions = {item["methodId"]: item["data"] for item in invocation.descriptor["methods"]["outputs"]}
    analysis = parameter(invocation.config.get("parameters", {}).get("analysis", "steady-stokes"))
    artifacts, exports, mappings, surface_mappings = {}, {}, {}, {}
    observers = surface_observers(invocation, domain)
    surface_methods = {"flow.volume-flow-rate", "flow.mass-flow-rate", "flow.surface-pressure", "flow.force", "flow.moment"}
    needs_surface = (any(output["methodId"] in surface_methods for output in invocation.config["outputs"])
                     or invocation.config.get("exports") or "traction" in invocation.descriptor.get("visualizations", {}))
    recovery = SurfaceRecovery(domain) if needs_surface else None
    traces = {}

    def sample_trace(selected, sample):
        key = float(selected["times"][sample])
        if key not in traces:
            traces[key] = recovery.trace(selected["pressure"][sample], selected["velocity"][sample])
        return traces[key]

    for output in invocation.config["outputs"]:
        grid = BoxGrid(output["boxGrid"])
        key = (tuple(grid.geometry["origin"]), tuple(grid.geometry["size"]),
               tuple(np.asarray(grid.geometry["rotation"]).ravel()), grid.shape, grid.geometry["lengthUnit"])
        parameters = output.get("parameters", {})
        scope = parameter(parameters.get("scope", "cumulative"))
        if scope not in {"final", "cumulative"}:
            raise ValueError("incompressible flow output scope must be cumulative or final")
        selected = samples if scope == "cumulative" and samples is not None else {
            "times": [time], "pressure": np.asarray(solution.pressure)[None, :],
            "velocity": np.asarray(solution.velocity)[None, :, :],
            "boundaryFlux": np.asarray(solution.face_volume_flux)[domain.mesh.boundary_interface_indices][None, :]
                            if needs_surface else None,
        }
        times = np.asarray(selected["times"], dtype=float)
        method = output["methodId"]
        metadata = {}
        if method in surface_methods:
            if grid.shape != (1, 1, 1):
                raise ValueError("flow boundary aggregate outputs require gridShape [1, 1, 1]")
            surface_name = parameter(parameters.get("surface"))
            if surface_name not in observers:
                raise ValueError(f"flow output references undefined surface observation {surface_name!r}")
            targets, boundaries = observers[surface_name]
            load = method in {"flow.force", "flow.moment"}
            if load:
                boundaries = select_surfaces(domain, targets, walls_only=True)
            surface_key = (key, tuple(boundaries))
            if surface_key not in surface_mappings:
                surface_mappings[surface_key] = SurfaceBoxOverlap.prepare(domain, boundaries, grid, invocation.cancellation)
            mapping = surface_mappings[surface_key]
            offset, contribution, origin = load_settings(parameters, moment=method == "flow.moment") if load else (0., "total", None)
            metadata = result_metadata(domain, definitions[method], targets=targets, pressure_offset=offset,
                                       contribution=contribution, moment_origin=origin)
            observed = []
            for sample in range(len(times)):
                if invocation.cancellation is not None:
                    invocation.cancellation.raise_if_cancelled()
                if method in {"flow.volume-flow-rate", "flow.mass-flow-rate"}:
                    value = mapping.volume_flow(selected["boundaryFlux"][sample], domain.mesh.boundary_interface_indices)
                    observed.append(value * (domain.density if method == "flow.mass-flow-rate" else 1.))
                elif method == "flow.surface-pressure":
                    observed.append(mapping.average_pressure(sample_trace(selected, sample)))
                else:
                    observed.append(mapping.force_moment(sample_trace(selected, sample), offset, contribution, origin))
            values = np.asarray(observed)
        else:
            metadata = result_metadata(domain, definitions[method])
            if key not in mappings:
                mappings[key] = TetrahedralBoxOverlap.prepare(domain.mesh.points, domain.mesh.cells, grid, invocation.cancellation)
            mapping = mappings[key]
        if method == "flow.pressure":
            values = mapping.average(np.moveaxis(selected["pressure"], 0, 1))
        elif method == "flow.velocity":
            values = mapping.average(np.moveaxis(selected["velocity"], 0, 1))
        elif method == "flow.mass-density":
            density = domain.density * mapping.fluid_volumes / mapping.box_cell_volume
            values = np.broadcast_to(density[..., None], (*grid.shape, len(times)))
        elif method not in surface_methods:
            raise ValueError(f"unsupported incompressible flow output {method!r}")
        artifacts[output["key"]] = pack_box_grid(grid, definitions[method], values, times=times)
        if metadata:
            artifacts[output["key"]]["metadata"] = metadata

    mesh = UnstructuredMeshValue(domain.mesh.points, {"tet4": domain.mesh.cells}, "m", domain.identity, domain.metadata)
    visualizations = {}
    for name, definition in invocation.descriptor.get("visualizations", {}).items():
        data = definition["data"]
        if name == "traction":
            if time not in traces:
                traces[time] = recovery.trace(solution.pressure, solution.velocity)
            boundaries = np.flatnonzero(np.asarray(domain.boundary_roles) == "wall")
            visualizations[name] = traction_field(domain, traces[time], boundaries, data, time=time,
                                                  targets=["fluid-boundary:no-slip"])
            continue
        metadata = {"configuration": "current", "sampling": "cell-average",
                    "weighting": "material-volume", "analysis": analysis, "time": time,
                    "sampleAxes": [{"axis": 1, "name": "time", "unit": "s", "ticks": [time]}]}
        metadata.update(result_metadata(domain, data))
        if name == "pressure":
            values, components = solution.pressure, None
            metadata.update(pressureKind="gauge", pressureReference=domain.metadata["pressureReference"])
        elif name == "velocity":
            values, components = solution.velocity, ("x", "y", "z")
        else:
            raise ValueError(f"unsupported incompressible flow visualization {name!r}")
        visualizations[name] = FieldValue(mesh, "cell", data["quantityKind"], data["unit"],
                                          np.asarray(values, dtype=data["dtype"])[:, None],
                                          data.get("basis"), components, metadata)
    export_definitions = {item["methodId"]: item["data"] for item in invocation.descriptor["methods"].get("exports", [])}
    for output in invocation.config.get("exports", []):
        if output["methodId"] != "flow.traction":
            raise ValueError(f"unsupported incompressible flow export {output['methodId']!r}")
        targets = output["target"]
        boundaries = select_surfaces(domain, targets, walls_only=True)
        offset, contribution, _ = load_settings(output.get("parameters", {}))
        if time not in traces:
            traces[time] = recovery.trace(solution.pressure, solution.velocity)
        exports[output["key"]] = traction_field(domain, traces[time], boundaries,
            export_definitions[output["methodId"]], time=time, targets=targets, offset=offset, contribution=contribution)
    return artifacts, exports, visualizations
