"""Passive Box Grid observations and a conservative native heat-source export."""

from app.kernel.api import FieldValue
from app.methods.fields.box_grid import BoxGrid, TetrahedralSampler, pack_box_grid


def build_dc_outputs(config, descriptor, result):
    domain = result.setup.mesh.field_domain
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts, exports = {}, {}
    fields = {"dc.potential": (result.potential, "node"), "dc.current-density": (result.current_density, "cell"),
              "dc.joule-heating": (result.joule_heating, "cell")}
    for output in config["outputs"]:
        method = output["methodId"]
        grid = BoxGrid(output["boxGrid"])
        if method == "dc.total-current":
            sampled = result.terminal_currents[output["parameters"]["terminal"]]
        elif method == "dc.total-power":
            sampled = result.input_power
        else:
            values, location = fields[method]
            sampler = TetrahedralSampler.prepare(domain.points, domain.cells["tet4"], grid.points("m"))
            sampled = sampler.sample(values, location=location)
        artifacts[output["key"]] = pack_box_grid(grid, definitions[method]["data"], sampled)
    for output in config.get("exports", ()):
        exports[output["key"]] = FieldValue(domain, "cell", "PowerDensity", "W.m-3", result.joule_heating)
    return artifacts, exports
