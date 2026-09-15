"""Particle measures on passive Box Grids and Catalog-declared native displays."""

from collections.abc import Mapping

import numpy as np

from app.kernel.api import BundleValue, ParticleSetValue
from app.kernel.api.units import convert_ucum_value
from app.methods.fields.box_grid import BoxGrid, pack_box_grid


def sample_cells(positions, velocity, mass, grid):
    local = grid.local_points(positions)
    size, shape = np.asarray(grid.geometry["size"]), np.asarray(grid.shape)
    valid = np.all((local >= 0) & (local <= size), axis=1)
    cells = np.minimum(np.floor(local[valid] / size * shape).astype(int), shape - 1)
    flat = np.ravel_multi_index(cells.T, grid.shape)
    cell_mass = np.zeros(grid.shape)
    momentum = np.zeros((*grid.shape, 3))
    np.add.at(cell_mass.reshape(-1), flat, np.asarray(mass)[valid])
    np.add.at(momentum.reshape(-1, 3), flat, np.asarray(mass)[valid, None] * velocity[valid])
    scale = convert_ucum_value(1.0, grid.geometry["lengthUnit"], "m")
    volume = np.prod(size * scale / shape)
    speed = np.divide(momentum, cell_mass[..., None], out=np.zeros_like(momentum),
                      where=cell_mass[..., None] > 0)
    return {"mass-density": cell_mass[..., None] / volume,
            "momentum-density": momentum / volume, "velocity": speed}


def build_outputs(config, descriptor, model, samples):
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts = {}
    for output in config.get("outputs", ()):
        raw_scope = output["parameters"].get("scope", "cumulative")
        scope = raw_scope.get("value") if isinstance(raw_scope, Mapping) else raw_scope
        if scope not in {"cumulative", "final"}:
            raise ValueError("particle output scope must be cumulative or final")
        selected = {name: value[-1:] if scope == "final" else value for name, value in samples.items()}
        grid = BoxGrid(output["boxGrid"])
        method = output["methodId"]
        quantity = method.split(".", 1)[1]
        values = [sample_cells(position, velocity, model["mass"], grid)[quantity]
                  for position, velocity in zip(selected["positions"], selected["velocity"], strict=True)]
        artifacts[output["key"]] = pack_box_grid(
            grid, definitions[method]["data"], np.stack(values, axis=3), times=selected["times"])
    return artifacts


def native_values(config, descriptor, model, samples, attributes):
    definitions = {item["methodId"]: item for item in descriptor["methods"].get("exports", ())}
    exports = {}
    for output in config.get("exports", ()):
        names = definitions[output["methodId"]]["data"]["attributes"]
        exports[output["key"]] = ParticleSetValue(
            positions=samples["positions"][-1], unit="m",
            attributes={name: attributes[name] for name in names},
            particle_ids=model["particleIds"], material_indices=model["materialIndices"],
            materials=tuple(model["materials"]), coordinate_frame="world",
            identity=f"{model['identity']}:{float(samples['times'][-1]).hex()}",
            metadata={"time": float(samples["times"][-1]), "provenance": model.get("provenance", {})})
    visuals = {}
    raw = {"positions": samples["positions"], "particleIds": model["particleIds"],
           "materialIndices": model["materialIndices"],
           "materialNames": np.asarray([entry["name"] for entry in model["materials"]]),
           "times": samples["times"]}
    for name, quantity in attributes.items():
        raw[name] = samples[name] if name in samples else np.broadcast_to(
            quantity.values, (len(samples["times"]), *quantity.values.shape))
        if raw[name].ndim > 3:
            raw[name] = raw[name].reshape(*raw[name].shape[:2], -1)
    for name, definition in descriptor.get("visualizations", {}).items():
        members = {}
        fields = definition["data"]["members"]
        for member, spec in fields.items():
            value = np.asarray(raw[member])
            axes = [{"implicitOrdinal": True} for _ in range(value.ndim)]
            if member == "times" or member == "positions" or member in attributes:
                axes[0] = {"ticks": samples["times"], "unit": "s"}
            if member == "positions" or member in attributes:
                axes[1] = {"ticks": model["particleIds"]}
            elif member in {"particleIds", "materialIndices"}:
                axes[0] = {"ticks": model["particleIds"]}
            for index, axis in enumerate(spec.get("axes", ())):
                if "ticks" in axis:
                    axes[index] = {"ticks": axis["ticks"]}
            members[member] = {"value": value, "axes": axes}
        visuals[name] = BundleValue(definition["artifactType"], members,
                                   metadata={"coordinateFrame": "world", "materials": tuple(model["materials"])})
    return exports, visuals
