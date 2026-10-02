"""Current material-volume pressure alongside conservative particle outputs."""

import numpy as np

from app.methods.fields.box_grid import BoxGrid, pack_box_grid
from app.methods.particles.outputs import build_outputs as particle_outputs, sample_weighted_cells
from app.methods.particles.time import parameter


def build_outputs(config, descriptor, model, samples):
    outputs = config.get("outputs", ())
    artifacts = particle_outputs(
        {**config, "outputs": [output for output in outputs if output["methodId"] != "sph.pressure"]},
        descriptor, model, samples,
    )
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    for output in outputs:
        if output["methodId"] != "sph.pressure":
            continue
        scope = parameter(output["parameters"].get("scope", "cumulative"))
        if scope not in {"cumulative", "final"}:
            raise ValueError("SPH output scope must be cumulative or final")
        selected = {name: value[-1:] if scope == "final" else value for name, value in samples.items()}
        grid = BoxGrid(output["boxGrid"])
        values = [
            sample_weighted_cells(positions, pressure, model["mass"] / density, grid)
            for positions, pressure, density in zip(
                selected["positions"], selected["pressure"], selected["density"], strict=True,
            )
        ]
        artifacts[output["key"]] = pack_box_grid(
            grid, definitions["sph.pressure"]["data"], np.stack(values, axis=3), times=selected["times"],
        )
    return artifacts
