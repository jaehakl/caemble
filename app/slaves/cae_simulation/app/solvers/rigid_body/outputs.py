"""Shared cell quadrature and native rigid mesh/pose snapshots."""

import numpy as np

from app.kernel.api import BundleValue, ContentKey
from app.kernel.api.units import convert_ucum_value
from app.methods.fields.box_grid import BoxGrid, pack_box_grid
from app.methods.geometry import TriangularMesh
from app.methods.rigid import angular_velocity, quaternion_to_matrix
from app.methods.structured.rasterize import rasterize_mesh_cell_centers

from .domain import parameter
from .evolution import history_values


async def sample_cells(model, state, grid, subdivisions, cancellation=None):
    """Accumulate mass and momentum with the exact same subcell material mask.

    The mask is tiled by ray columns so workspace scales with a chunk, not the
    product of the full high-resolution observation volume and triangle count.
    """
    shape = grid.shape
    density = np.zeros(shape, dtype=float)
    momentum = np.zeros((*shape, 3), dtype=float)
    flat_density, flat_momentum = density.reshape(-1), momentum.reshape(-1, 3)
    ticks = tuple((np.arange(count * subdivisions) + .5) * size / (count * subdivisions)
                  for count, size in zip(shape, grid.geometry["size"], strict=True))
    rotations = quaternion_to_matrix(state["orientation"])
    omega = angular_velocity(state["orientation"], model["inverseInertias"], state["angularMomentum"])
    box_rotation = np.asarray(grid.geometry["rotation"])
    box_origin = np.asarray(grid.geometry["origin"])
    box_scale = convert_ucum_value(1., grid.geometry["lengthUnit"], "m")
    for body in range(len(model["masses"])):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        v0, v1 = model["vertexOffsets"][body:body + 2]
        f0, f1 = model["triangleOffsets"][body:body + 2]
        local = model["vertices"][v0:v1] - model["localCenters"][body]
        world = state["position"][body] + local @ rotations[body].T
        vertices = grid.local_points(world)
        mesh = TriangularMesh(vertices, model["triangles"][f0:f1] - v0, ())
        lower, upper = vertices.min(axis=0), vertices.max(axis=0)
        ranges = [np.flatnonzero((axis >= low) & (axis <= high))
                  for axis, low, high in zip(ticks, lower, upper, strict=True)]
        if any(not len(indices) for indices in ranges):
            continue
        xs, ys, zs = ranges
        columns = max(1, min(128, 1_000_000 // max(len(mesh.triangles), 1)))
        contribution = model["densities"][body] / subdivisions**3
        for zi in zs:
            for start in range(0, len(ys), columns):
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                selected_y = ys[start:start + columns]
                mask = await rasterize_mesh_cell_centers(mesh, ticks[0][xs], ticks[1][selected_y], ticks[2][zi:zi + 1])
                _, iy, ix = np.nonzero(mask)
                if not len(ix):
                    continue
                x_indices, y_indices = xs[ix], selected_y[iy]
                indices = np.ravel_multi_index((x_indices // subdivisions,
                                               y_indices // subdivisions,
                                               np.full(len(ix), zi // subdivisions)), shape)
                sample_local = np.column_stack((ticks[0][x_indices], ticks[1][y_indices],
                                                np.full(len(ix), ticks[2][zi])))
                sample_world = (box_origin + sample_local @ box_rotation.T) * box_scale
                speed = state["velocity"][body] + np.cross(omega[body], sample_world - state["position"][body])
                np.add.at(flat_density, indices, contribution)
                np.add.at(flat_momentum, indices, contribution * speed)
    velocity = np.divide(momentum, density[..., None], out=np.zeros_like(momentum),
                         where=density[..., None] > 0)
    return {"rigid.mass-density": density[..., None], "rigid.velocity": velocity,
            "rigid.momentum-density": momentum}


async def build_outputs(invocation, model, saved):
    subdivisions = int(parameter(invocation.config["parameters"].get("subcellSamplesPerAxis", 4)))
    if subdivisions < 1:
        raise ValueError("subcellSamplesPerAxis must be positive")
    definitions = {item["methodId"]: item for item in invocation.descriptor["methods"]["outputs"]}
    artifacts, sampled_grids = {}, {}
    for output in invocation.config.get("outputs", ()):
        scope = parameter(output["parameters"].get("scope", "cumulative"))
        history = history_values(saved, scope)
        grid = BoxGrid(output["boxGrid"])
        key = str(ContentKey.from_parts("rigid.output-grid", grid.geometry, scope, subdivisions))
        if key not in sampled_grids:
            values = []
            for index, _ in enumerate(history["times"]):
                state = {name: history[name][index] for name in
                         ("position", "velocity", "orientation", "angularMomentum")}
                values.append(await sample_cells(model, state, grid, subdivisions, invocation.cancellation))
            sampled_grids[key] = {method: np.stack([value[method] for value in values], axis=3)
                                  for method in values[0]}
        method = output["methodId"]
        artifacts[output["key"]] = pack_box_grid(grid, definitions[method]["data"],
                                                sampled_grids[key][method], times=history["times"])
    return artifacts


def native_members(model, samples, *, mesh=False):
    """Body axes carry IDs explicitly, independently of mesh and state row order."""
    body_ids = list(model["bodyIds"])
    times = samples["times"]
    with np.errstate(over="ignore", invalid="ignore"):
        omega = angular_velocity(samples["orientation"], model["inverseInertias"], samples["angularMomentum"])
    raw = {
        "bodyIds": np.asarray(body_ids), "rootIds": np.asarray(model["rootIds"]),
        "times": times, "positions": samples["position"], "orientations": samples["orientation"],
        "velocities": samples["velocity"],
        "angularVelocities": omega,
        "localCenters": model["localCenters"], "masses": model["masses"], "inertias": model["inertias"],
    }
    if mesh:
        raw.update({name: model[name] for name in
                    ("vertices", "triangles", "vertexOffsets", "triangleOffsets")})
    motion_members = {"positions", "orientations", "velocities", "angularVelocities"}
    body_members = {"bodyIds", "rootIds", "localCenters", "masses", "inertias"}
    members = {}
    for name, value in raw.items():
        if value.dtype.kind in "biufc" and not np.all(np.isfinite(value)):
            coordinate = np.argwhere(~np.isfinite(value))[0]
            time = times[coordinate[0]] if name in motion_members or name == "times" else times[-1]
            if name in motion_members:
                affected = [body_ids[coordinate[1]]]
            elif name in body_members:
                affected = [body_ids[coordinate[0]]]
            elif name == "vertices":
                body = np.searchsorted(model["vertexOffsets"], coordinate[0], side="right") - 1
                affected = [body_ids[body]]
            else:
                affected = body_ids
            raise ValueError(f"rigid native {name} is nonfinite at time {time:g} s for bodies {affected!r}")
        if name in motion_members:
            axes = [{"ticks": times}, {"ticks": body_ids}, {"implicitOrdinal": True}]
        elif name in body_members:
            axes = [{"ticks": body_ids}, *({"implicitOrdinal": True} for _ in range(value.ndim - 1))]
        elif name == "times":
            axes = [{"ticks": times}]
        else:
            axes = [{"implicitOrdinal": True} for _ in range(value.ndim)]
        members[name] = {"value": value, "axes": axes}
    return members


def build_native(invocation, model, saved):
    endpoint = {"times": np.asarray([saved["time"]]),
                **{name: np.asarray(saved[name])[None] for name in
                   ("position", "velocity", "orientation", "angularMomentum")}}
    definitions = {item["methodId"]: item for item in invocation.descriptor["methods"].get("exports", ())}
    exports = {output["key"]: BundleValue(definitions[output["methodId"]]["artifactType"],
                                         native_members(model, endpoint))
               for output in invocation.config.get("exports", ())}
    history = history_values(saved)
    if history["times"][-1] != saved["time"]:
        history = {name: np.concatenate((value, endpoint[name])) for name, value in history.items()}
    visuals = {name: BundleValue(definition["artifactType"], native_members(model, history, mesh=True))
               for name, definition in invocation.descriptor.get("visualizations", {}).items()}
    return exports, visuals
