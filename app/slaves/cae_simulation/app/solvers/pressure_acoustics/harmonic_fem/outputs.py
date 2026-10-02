"""Passive Box Grid recording and explicit harmonic mesh visualization."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.methods.fields.box_grid import BoxGrid, TetrahedralSampler, pack_box_grid


def build_outputs(config, descriptor, model, solution):
    definitions = {item["methodId"]: item["data"] for item in descriptor["methods"]["outputs"]}
    artifacts = {}
    for output in config["outputs"]:
        if output["methodId"] != "acoustics.pressure":
            raise ValueError(f"unsupported acoustic output {output['methodId']!r}")
        grid = BoxGrid(output["boxGrid"])
        sampler = TetrahedralSampler.prepare(model.points, model.cells, grid.points("m"))
        values = sampler.sample(solution.pressure)
        artifacts[output["key"]] = pack_box_grid(grid, definitions[output["methodId"]], values, frequencies=solution.frequencies)
    visuals = {}
    for name, definition in descriptor.get("visualizations", {}).items():
        if name != "pressure":
            raise ValueError(f"unsupported acoustic visualization {name!r}")
        domain = UnstructuredMeshValue(model.points, {"tet4": model.cells.astype(np.int32)}, "m", model.identity, model.metadata or {})
        data = definition["data"]["members"]["field"]
        field = FieldValue(domain, "node", data["quantityKind"], data["unit"],
                           solution.pressure[:, :, None].astype(np.complex64), data.get("basis"), ("pressure",),
                           {"sampleAxes": [{"axis": 1, "name": "frequency", "unit": "Hz", "ticks": solution.frequencies}]})
        visuals[name] = BundleValue(definition["artifactType"], {
            "field": field,
            "frequencies": {"value": solution.frequencies, "axes": [{"ticks": solution.frequencies}]},
        }, {"timeConvention": "exp(+i*omega*t)", "amplitude": "peak"})
    return artifacts, visuals
