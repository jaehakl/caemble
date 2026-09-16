"""Passive fluid-volume observations and native fields at the accepted window end."""

import numpy as np

from app.kernel.api import FieldValue, UnstructuredMeshValue
from app.methods.coupling.tetrahedral import TetrahedralBoxOverlap
from app.methods.fields.box_grid import BoxGrid, pack_box_grid

from .domain import parameter


def build_outputs(invocation, domain, solution, *, samples=None, time=0.):
    definitions = {item["methodId"]: item["data"] for item in invocation.descriptor["methods"]["outputs"]}
    analysis = parameter(invocation.config.get("parameters", {}).get("analysis", "steady-stokes"))
    artifacts, mappings = {}, {}
    for output in invocation.config["outputs"]:
        grid = BoxGrid(output["boxGrid"])
        key = (tuple(grid.geometry["origin"]), tuple(grid.geometry["size"]),
               tuple(np.asarray(grid.geometry["rotation"]).ravel()), grid.shape, grid.geometry["lengthUnit"])
        if key not in mappings:
            mappings[key] = TetrahedralBoxOverlap.prepare(domain.mesh.points, domain.mesh.cells, grid, invocation.cancellation)
        mapping = mappings[key]
        scope = parameter(output.get("parameters", {}).get("scope", "cumulative"))
        if scope not in {"final", "cumulative"}:
            raise ValueError("incompressible flow output scope must be cumulative or final")
        selected = samples if scope == "cumulative" and samples is not None else {
            "times": [time], "pressure": np.asarray(solution.pressure)[None, :],
            "velocity": np.asarray(solution.velocity)[None, :, :],
        }
        times = np.asarray(selected["times"], dtype=float)
        method = output["methodId"]
        if method == "flow.pressure":
            values = mapping.average(np.moveaxis(selected["pressure"], 0, 1))
        elif method == "flow.velocity":
            values = mapping.average(np.moveaxis(selected["velocity"], 0, 1))
        elif method == "flow.mass-density":
            density = domain.density * mapping.fluid_volumes / mapping.box_cell_volume
            values = np.broadcast_to(density[..., None], (*grid.shape, len(times)))
        else:
            raise ValueError(f"unsupported incompressible flow output {method!r}")
        artifacts[output["key"]] = pack_box_grid(grid, definitions[method], values, times=times)

    mesh = UnstructuredMeshValue(domain.mesh.points, {"tet4": domain.mesh.cells}, "m", domain.identity, domain.metadata)
    visualizations = {}
    for name, definition in invocation.descriptor.get("visualizations", {}).items():
        data = definition["data"]
        metadata = {"configuration": "current", "sampling": "cell-average",
                    "weighting": "material-volume", "analysis": analysis, "time": time,
                    "sampleAxes": [{"axis": 1, "name": "time", "unit": "s", "ticks": [time]}]}
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
    return artifacts, visualizations
