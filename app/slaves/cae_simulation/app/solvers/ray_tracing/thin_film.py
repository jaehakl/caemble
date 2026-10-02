"""Surface-bound stacks reuse the existing coherent multilayer calculation."""

import math
import numpy as np

from app.kernel.api.world import material_model, target_group
from app.kernel.api.units import convert_ucum_value
from app.methods.optics import VACUUM_LIGHT_SPEED
from .domain import THIN_LAYER_LIMIT, surface_keys


def surface_films(context, scene, solids, excluded):
    films = {}
    parts = {part["id"]: part for part in scene["roots"]}
    stacks = {}
    for rule in context.config["boundaryConditions"]:
        if rule["methodId"] != "ray.thin-film-stack":
            continue
        keys = surface_keys(scene, target_group(rule, "surface"), solids)
        if not keys:
            raise ValueError(
                "Thin-film target must resolve to a boundary in ray.domain"
            )
        for key in keys:
            if key in films or key in excluded:
                raise ValueError(
                    "Thin-film surfaces cannot have duplicate stacks, detectors or gratings"
                )
            if key.root_id not in stacks:
                model = material_model(
                    context.world, parts[key.root_id], "thinFilm", "stack"
                )
                if model is None or model["model"] != "optics.thin-film-stack@1":
                    raise ValueError(
                        "Thin-film surface requires optics.thin-film-stack@1"
                    )
                layers = model["parameters"]["layers"]
                if not layers:
                    raise ValueError("Thin-film stack requires at least one layer")
                for layer in layers:
                    thickness = convert_ucum_value(
                        layer["thickness"]["value"], layer["thickness"]["unit"], "um"
                    )
                    if (
                        not math.isfinite(thickness)
                        or not 0 < thickness < THIN_LAYER_LIMIT * 1e6
                    ):
                        raise ValueError(
                            "Thin-film thickness must be strictly between 0 and 50 micrometers; use explicit solids for thicker layers"
                        )
                    previous = 0.0
                    if not layer["samples"]:
                        raise ValueError("Thin-film layer requires frequency samples")
                    for sample in layer["samples"]:
                        frequency, n, k = (
                            float(sample[name]["value"])
                            for name in ("frequency", "n", "k")
                        )
                        if (
                            not all(math.isfinite(value) for value in (frequency, n, k))
                            or frequency <= previous
                            or n <= 0
                            or k < 0
                        ):
                            raise ValueError(
                                "Thin-film samples require increasing positive frequencies, n > 0 and k >= 0"
                            )
                        previous = frequency
                stacks[key.root_id] = layers
            layers = stacks[key.root_id]
            films[key] = layers
    return films


def film_layers(layers, wavelength):
    frequency = VACUUM_LIGHT_SPEED / wavelength
    result = []
    for layer in layers:
        samples = layer["samples"]
        frequencies = [sample["frequency"]["value"] for sample in samples]
        n = np.interp(
            frequency, frequencies, [sample["n"]["value"] for sample in samples]
        )
        k = np.interp(
            frequency, frequencies, [sample["k"]["value"] for sample in samples]
        )
        thickness = convert_ucum_value(
            layer["thickness"]["value"], layer["thickness"]["unit"], "m"
        )
        result.append((complex(n, -k), thickness))
    return result
