from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace

import numpy as np
from app.kernel.api import BundleValue, FieldValue, StructuredGridValue

from app.methods.coupling import project_structured_scalar_cell_averages
from app.methods.finite_volume import create_scalar_finite_volume_system
from app.methods.structured import (
    VoxelDomain,
    structured_grid_value,
)
from app.solvers.dc_current_density.domain import DcDomain
from app.solvers.dc_current_density.formulation import DcSolution
from app.solvers.dc_current_density.outputs import build_dc_outputs
from app.solvers.ray_tracing.outputs import build_ray_outputs
from app.solvers.steady_state_heat.formulation import _volume_source


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

    def test_heat_source_consumes_canonical_field_and_projects_to_target(self) -> None:
        domain = _domain((2, 1, 1))
        domain_ref = _domain_ref(domain)
        values = np.asarray([[[2.0]], [[4.0]]])
        typed = FieldValue(domain=domain_ref, location="cell", values=values, quantity_kind="PowerDensity", unit="W.m-3")

        np.testing.assert_allclose(_volume_source(typed, domain, 2.0, domain_ref), [1.0, 2.0])
        target = _domain((4, 1, 1))
        np.testing.assert_allclose(
            _volume_source(typed, target, 2.0, _domain_ref(target)),
            [1.0, 1.0, 2.0, 2.0],
        )


class SolverOutputTests(unittest.TestCase):
    def test_dc_joule_heating_retains_its_canonical_domain(self) -> None:
        domain = _domain((3, 1, 1))
        domain_ref = _domain_ref(domain)
        setup = DcDomain(domain, domain_ref, 1.0, 0.0, 1.0, None, True)
        system = create_scalar_finite_volume_system(domain, 0.0, 1.0)
        solution = DcSolution(
            setup,
            system,
            np.asarray([1 / 6, 1 / 2, 5 / 6]),
            np.asarray([1 / 6, 1 / 2, 5 / 6]),
            0,
            0.0,
        )
        config = {"outputs": [{"methodId": "dc.joule-heating", "key": "jouleHeating"}]}
        descriptor = {
            "methods": {
                "outputs": [
                    {
                        "methodId": "dc.joule-heating",
                        "data": {"quantityKind": "PowerDensity", "unit": "W.m-3"},
                    }
                ]
            }
        }

        async def progress(_event: object) -> None:
            return None

        artifacts = asyncio.run(build_dc_outputs(config, descriptor, solution, progress))
        field = artifacts["jouleHeating"]
        self.assertIsInstance(field, FieldValue)
        self.assertEqual(field.domain.identity, domain_ref.identity)
        self.assertIsInstance(field.values, np.ndarray)
        self.assertEqual(field.domain.shape, field.values.shape)

    def test_ray_path_artifact_is_only_added_when_requested(self) -> None:
        bundle = BundleValue("caemble.ray/paths@1", {"vertices": {"value": np.empty((0, 3), dtype=np.float32)}})
        config = {"outputs": [{"methodId": "ray.paths", "key": "paths"}]}
        progress_events: list[object] = []

        async def progress(event: object) -> None:
            progress_events.append(event)

        artifacts = asyncio.run(build_ray_outputs(config, [], 0.0, bundle, progress, {}))

        self.assertEqual(artifacts["paths"].bundle_type, "caemble.ray/paths@1")
        self.assertIs(artifacts["paths"], bundle)
        self.assertEqual(len(progress_events), 1)


if __name__ == "__main__":
    unittest.main()
