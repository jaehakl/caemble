from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace

import numpy as np
from app.kernel.api import BundleValue, FieldValue, StructuredGridValue

from app.methods.coupling import project_structured_scalar_cell_averages
from app.methods.coupling.assembly import transfer_assembly_cell_field
from app.methods.geometry import GeometryService
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import VolumeSubdomain
from app.methods.structured import (
    VoxelDomain,
    structured_grid_value,
)
from app.solvers.dc_current_density.domain import DcDomain
from app.solvers.dc_current_density.formulation import solve_dc
from app.solvers.dc_current_density.outputs import build_dc_outputs
from app.solvers.ray_tracing.outputs import PathCollector
from tests.test_scalar_fem import layered_scene


def _domain(shape: tuple[int, int, int]) -> VoxelDomain:
    return VoxelDomain(
        shape=shape,
        axis=np.asarray([1.0, 0.0, 0.0]),
        length=2.0,
        minimum_u=-0.5,
        minimum_v=-0.5,
        axial_spacing=2.0 / shape[0],
        u_spacing=1.0 / shape[1],
        v_spacing=1.0 / shape[2],
        occupancy=np.ones(np.prod(shape), dtype=np.uint8),
        occupied_count=int(np.prod(shape)),
    )


def _domain_ref(domain: VoxelDomain) -> StructuredGridValue:
    return structured_grid_value(
        domain,
        geometry_hashes=["geometry"],
        root_ids=["part"],
        reference_length_unit="m",
    )


class StructuredCouplingTests(unittest.TestCase):
    def test_same_domain_uses_the_original_field_values(self) -> None:
        domain = _domain((2, 1, 1))
        domain_ref = _domain_ref(domain)
        values = np.asarray([[[2.0]], [[4.0]]])
        field = FieldValue(domain=domain_ref, location="cell", values=values, quantity_kind="PowerDensity", unit="W.m-3")

        resolved = project_structured_scalar_cell_averages(field, domain_ref, source_spacing=field.domain.metadata["spacings"], target_spacing=domain_ref.metadata["spacings"]).values

        self.assertIs(resolved, values)

    def test_conservative_projection_preserves_piecewise_constant_integral(self) -> None:
        source = _domain((2, 1, 1))
        target = _domain((4, 1, 1))
        source_ref = _domain_ref(source)
        target_ref = _domain_ref(target)
        values = np.asarray([[[2.0]], [[4.0]]])
        field = FieldValue(domain=source_ref, location="cell", values=values, quantity_kind="PowerDensity", unit="W.m-3")

        projected = project_structured_scalar_cell_averages(field, target_ref, source_spacing=field.domain.metadata["spacings"], target_spacing=target_ref.metadata["spacings"]).values

        np.testing.assert_allclose(projected[:, 0, 0], [2.0, 2.0, 4.0, 4.0])
        source_integral = float(np.sum(values) * source.axial_spacing)
        target_integral = float(np.sum(projected) * target.axial_spacing)
        self.assertAlmostEqual(source_integral, target_integral)

    def test_conservative_projection_rejects_different_support(self) -> None:
        source = _domain((2, 1, 1))
        target = _domain((4, 1, 1))
        source_ref = _domain_ref(source)
        target_ref = _domain_ref(target)
        target_ref = replace(target_ref, axes=(target_ref.axes[0] + 0.25, *target_ref.axes[1:]))
        values = np.asarray([[[2.0]], [[4.0]]])
        field = FieldValue(domain=source_ref, location="cell", values=values, quantity_kind="PowerDensity", unit="W.m-3")

        with self.assertRaisesRegex(ValueError, "same region"):
            project_structured_scalar_cell_averages(field, target_ref, source_spacing=field.domain.metadata["spacings"], target_spacing=target_ref.metadata["spacings"]).values

    def test_new_heat_source_rejects_legacy_structured_fields(self) -> None:
        domain = _domain((2, 1, 1))
        domain_ref = _domain_ref(domain)
        values = np.asarray([[[2.0]], [[4.0]]])
        typed = FieldValue(domain=domain_ref, location="cell", values=values, quantity_kind="PowerDensity", unit="W.m-3")

        with self.assertRaises(ValueError):
            transfer_assembly_cell_field(typed, domain_ref, quantity_kind="PowerDensity", unit="W.m-3")


class SolverOutputTests(unittest.TestCase):
    def test_dc_joule_heating_retains_its_canonical_domain(self) -> None:
        mesh = asyncio.run(GeometryService().volume_mesh(layered_scene(), ("base", "metal"), "m", VolumeMeshingProfile(.2, layer_axis=2)))
        domain = VolumeSubdomain.create(mesh, "output-assembly", ["metal"])
        x = domain.field_domain.points[:, 0]
        left, right = np.flatnonzero(np.isclose(x, -.5)), np.flatnonzero(np.isclose(x, .5))
        fixed = {int(i): 1. for i in left}
        fixed.update((int(i), 0.) for i in right)
        conductivity = np.broadcast_to(np.eye(3), (len(domain.cell_ids), 3, 3))
        solution = solve_dc(DcDomain(domain, conductivity, fixed, {"source": {"nodes": left, "voltage": 1.}, "reference": {"nodes": right, "voltage": 0.}}), 1e-8)
        config = {"outputs": [], "exports": [{"methodId": "dc.joule-heating", "key": "jouleHeating"}]}
        descriptor = {
            "methods": {
                "outputs": [], "exports": [
                    {
                        "methodId": "dc.joule-heating",
                        "data": {"quantityKind": "PowerDensity", "unit": "W.m-3"},
                    }
                ]
            }
        }

        artifacts, exports = build_dc_outputs(config, descriptor, solution)
        field = exports["jouleHeating"]
        self.assertEqual(artifacts, {})
        self.assertIsInstance(field, FieldValue)
        self.assertEqual(field.domain.identity, domain.field_domain.identity)
        self.assertIsInstance(field.values, np.ndarray)
        self.assertEqual((len(domain.cell_ids),), field.values.shape)
        self.assertAlmostEqual(float(field.values @ domain.elements.volumes), solution.input_power)

    def test_empty_ray_path_visualization_is_available_without_output_request(self) -> None:
        bundle = PathCollector(0).bundle()
        self.assertEqual(bundle.bundle_type, "caemble.ray/paths@1")
        self.assertEqual(bundle.members["pathOffsets"]["value"].tolist(), [0])
        self.assertEqual(bundle.members["vertices"]["value"].shape, (0, 3))


if __name__ == "__main__":
    unittest.main()
