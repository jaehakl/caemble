"""Electrical native coupling fields and passive Box Grid observations."""

import numpy as np

from app.kernel.api import FieldValue
from app.methods.fields.box_grid import BoxGrid, clip_box_polygon, pack_box_grid, sample_voxel_field, voxel_frame
from app.methods.structured import dense_voxel_field, axis_ticks, round_like_javascript
from app.kernel.api.world import scalar_parameter

from .formulation import _gradient, _cross_section


async def build_dc_outputs(config, descriptor, result, progress):
    domain = result.setup.grid
    current = np.zeros((domain.occupancy.size, 3), dtype=np.float64)
    joule = np.zeros(domain.occupancy.size, dtype=np.float64)
    frame = voxel_frame(domain)
    for index in np.flatnonzero(domain.occupancy):
        gradient = _gradient(domain, result.potential, int(index), result.setup.source_voltage,
                             result.setup.reference_voltage, result.setup.surface_terminals)
        current[index] = -result.setup.conductivity * (frame @ gradient)
        joule[index] = result.setup.conductivity * np.dot(gradient, gradient)
    values = {
        "dc.current-density": np.stack([dense_voxel_field(domain, current[:, axis]) for axis in range(3)], axis=-1),
        "dc.joule-heating": dense_voxel_field(domain, joule),
    }
    definitions = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    artifacts, exports = {}, {}
    for index, output in enumerate(config["outputs"]):
        data = definitions[output["methodId"]]["data"]
        grid = BoxGrid(output["boxGrid"])
        if output["methodId"] == "dc.total-current":
            position = scalar_parameter(output["parameters"]["crossSectionPosition"])
            densities, _ = _cross_section(result.potential, domain, position, result.setup.conductivity,
                                         result.setup.source_voltage, result.setup.reference_voltage, True,
                                         result.setup.surface_terminals)
            axial = -domain.length / 2 + min(domain.shape[0], max(0, round_like_javascript(position * domain.shape[0]))) * domain.axial_spacing
            _, v_ticks, u_ticks = axis_ticks(domain)
            total = 0.0
            for row, v in enumerate(v_ticks):
                for column, u in enumerate(u_ticks):
                    center = domain.origin + frame @ [axial, u, v]
                    corners = np.asarray([center + frame @ [0, du * domain.u_spacing / 2, dv * domain.v_spacing / 2]
                                          for du, dv in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
                    polygon = clip_box_polygon(corners, grid, descriptor["referenceLengthUnit"])
                    area = sum(np.linalg.norm(np.cross(polygon[i] - polygon[0], polygon[i + 1] - polygon[0])) / 2
                               for i in range(1, len(polygon) - 1))
                    total += densities[row, column] * area
            sampled = abs(total)
        else:
            sampled = sample_voxel_field(domain, values[output["methodId"]], grid, descriptor["referenceLengthUnit"])
        artifacts[output["key"]] = pack_box_grid(grid, data, sampled)
        if progress is not None:
            await progress({"stage": "output", "completed": index + 1, "total": len(config["outputs"])})
    definitions = {item["methodId"]: item for item in descriptor["methods"].get("exports", ())}
    for output in config.get("exports", ()):
        data = definitions[output["methodId"]]["data"]
        exports[output["key"]] = FieldValue(result.setup.field_domain, "cell", data["quantityKind"],
                                           data["unit"], values[output["methodId"]])
    return artifacts, exports
