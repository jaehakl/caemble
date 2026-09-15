"""Finite-deformation observations alongside the existing conservative outputs."""

import numpy as np

from app.methods.fields.box_grid import BoxGrid, pack_box_grid
from app.methods.particles.outputs import build_outputs as particle_outputs, sample_weighted_cells
from app.methods.particles.time import parameter


def build_outputs(config, descriptor, model, samples):
    conservative = {"mpm.mass-density", "mpm.momentum-density", "mpm.velocity"}
    artifacts = particle_outputs({**config, "outputs": [item for item in config["outputs"] if item["methodId"] in conservative]}, descriptor, model, samples)
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    for output in config["outputs"]:
        method = output["methodId"]
        if method in conservative:
            continue
        scope = parameter(output["parameters"].get("scope", "cumulative"))
        if scope not in {"cumulative", "final"}:
            raise ValueError("MPM output scope must be cumulative or final")
        selected = {name: value[-1:] if scope == "final" else value for name, value in samples.items()}
        data = definitions[method]["data"]
        grid = BoxGrid(output["boxGrid"])
        values = []
        for index, positions in enumerate(selected["positions"]):
            if method == "mpm.strain-energy":
                sampled = np.sum(model["referenceVolume"] * selected["strainEnergyDensity"][index])
            elif method == "mpm.kinetic-energy":
                sampled = .5 * np.sum(model["mass"][:, None] * selected["velocity"][index]**2)
            else:
                name = method.removeprefix("mpm.").removeprefix("reference-")
                quantity = {"displacement": "displacement", "stress-field": "stress", "volume-ratio": "volumeRatio"}[name]
                reference = data["boxGrid"]["configuration"] == "reference"
                weights = model["referenceVolume"] if reference else model["referenceVolume"] * selected["volumeRatio"][index]
                points = model["referencePositions"] if reference else positions
                field = selected[quantity][index]
                if quantity == "stress":
                    field = field[:, (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)]
                sampled = sample_weighted_cells(points, field, weights, grid)
            if data["boxGrid"]["sampling"] == "aggregate" and grid.shape != (1, 1, 1):
                raise ValueError("MPM total energy requires gridShape [1, 1, 1]")
            values.append(np.asarray(sampled).reshape(*grid.shape, -1))
        artifacts[output["key"]] = pack_box_grid(grid, data, np.stack(values, axis=3), times=selected["times"])
    return artifacts
