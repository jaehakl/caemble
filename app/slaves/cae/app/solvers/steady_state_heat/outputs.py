"""Temperature fields sampled independently of the thermal computation grid."""

import numpy as np

from app.kernel.api import FieldValue
from app.methods.fields.box_grid import BoxGrid, box_intersects_cells, pack_box_grid, sample_voxel_field, voxel_frame
from app.methods.structured import dense_field, axis_ticks, dense_voxel_field


async def build_heat_outputs(config, result, progress, descriptor):
    values = dense_field(result.setup.grid, result.system, result.active_values)
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts, exports = {}, {}
    for index, output in enumerate(config["outputs"]):
        grid = BoxGrid(output["boxGrid"])
        sampled = sample_voxel_field(result.setup.grid, values, grid, descriptor["referenceLengthUnit"])
        if output["methodId"] == "heat.maximum-temperature":
            domain = result.setup.grid
            coordinates = np.stack(np.meshgrid(*axis_ticks(domain), indexing="ij"), axis=-1)
            native_points = domain.origin + coordinates @ voxel_frame(domain)[:, [0, 2, 1]].T
            selected = box_intersects_cells(grid, native_points,
                                           np.array([domain.axial_spacing, domain.v_spacing, domain.u_spacing]) / 2,
                                           voxel_frame(domain)[:, [0, 2, 1]], descriptor["referenceLengthUnit"])
            selected &= dense_voxel_field(domain, domain.occupancy).astype(bool)
            sampled = np.max(values[selected]) if selected.any() else 0.0
        artifacts[output["key"]] = pack_box_grid(grid, definitions[output["methodId"]]["data"], sampled)
        if progress is not None:
            await progress({"stage": "output", "completed": index + 1, "total": len(config["outputs"])})
    definitions = {item["methodId"]: item for item in descriptor["methods"].get("exports", ())}
    for output in config.get("exports", ()):
        data = definitions[output["methodId"]]["data"]
        exports[output["key"]] = FieldValue(result.setup.field_domain, "cell", data["quantityKind"], data["unit"], values)
    return artifacts, exports
