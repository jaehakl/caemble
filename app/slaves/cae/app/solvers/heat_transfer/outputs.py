"""Temperature, occupancy and aggregates independent of observation resolution."""

from app.kernel.api import ContentKey, FieldValue
from app.methods.fields.box_grid import BoxGrid, TetrahedralSampler, pack_box_grid
from app.methods.fields.tetrahedral import scalar_box_statistics


def build_heat_outputs(config, descriptor, result):
    domain = result.setup.mesh.field_domain
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts, exports = {}, {}
    statistics, samplers = {}, {}
    for output in config["outputs"]:
        method = output["methodId"]
        grid = BoxGrid(output["boxGrid"])
        key = ContentKey.from_parts("heat-observation-box", grid.geometry)
        if method in ("heat.mean-temperature", "heat.maximum-temperature", "heat.temperature-range"):
            if key not in statistics:
                statistics[key] = scalar_box_statistics(domain.points, domain.cells["tet4"], result.temperature, grid)
            mean, minimum, maximum = statistics[key]
            sampled = mean if method == "heat.mean-temperature" else maximum if method == "heat.maximum-temperature" else maximum - minimum
        elif method == "heat.outward-power":
            sampled = result.outward_power
        elif method == "heat.stored-energy":
            sampled = result.stored_energy
        elif method == "heat.storage-power":
            sampled = result.storage_power
        elif method == "heat.source-power":
            sampled = result.source_power
        elif method == "heat.energy-imbalance":
            sampled = result.source_power - result.outward_power - result.storage_power
        else:
            if key not in samplers:
                samplers[key] = TetrahedralSampler.prepare(domain.points, domain.cells["tet4"], grid.points("m"))
            sampler = samplers[key]
            sampled = (sampler.cell_indices >= 0).astype(float).reshape(grid.shape) if method == "heat.valid-domain" else sampler.sample(result.temperature)
        artifacts[output["key"]] = pack_box_grid(grid, definitions[method]["data"], sampled)
    for output in config.get("exports", ()):
        exports[output["key"]] = FieldValue(domain, "node", "thermodynamics.Temperature", "K", result.temperature)
    return artifacts, exports
