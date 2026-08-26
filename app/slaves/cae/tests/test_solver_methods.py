from __future__ import annotations

import asyncio
import unittest

import numpy as np

from app.methods.coupling import values_on_structured_grid
from app.methods.finite_volume import create_scalar_finite_volume_system
from app.methods.rays import RAY_PATH_BUNDLE_KIND
from app.methods.structured import (
    STRUCTURED_FIELD_KIND,
    VoxelDomain,
    structured_cell_field,
    structured_grid_ref,
)
from app.solvers.dc_current_density.domain import DcDomain
from app.solvers.dc_current_density.formulation import DcSolution
from app.solvers.dc_current_density.outputs import build_dc_outputs
from app.solvers.ray_tracing.outputs import build_ray_outputs
from app.solvers.steady_state_heat.formulation import _volume_source
from app.solvers.steady_state_heat.solver import _legacy_heat_source


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


def _domain_ref(domain: VoxelDomain) -> dict[str, object]:
    return structured_grid_ref(
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
        field = structured_cell_field(
            domain_ref,
            values,
            domain_ref["axes"],
            quantity_kind="PowerDensity",
            unit="W.m-3",
        )

        resolved = values_on_structured_grid(field, domain_ref)

        self.assertIs(resolved, values)

    def test_conservative_projection_preserves_piecewise_constant_integral(self) -> None:
        source = _domain((2, 1, 1))
        target = _domain((4, 1, 1))
        source_ref = _domain_ref(source)
        target_ref = _domain_ref(target)
        values = np.asarray([[[2.0]], [[4.0]]])
        field = structured_cell_field(
            source_ref,
            values,
            source_ref["axes"],
            quantity_kind="PowerDensity",
            unit="W.m-3",
        )

        projected = values_on_structured_grid(field, target_ref)

        np.testing.assert_allclose(projected[:, 0, 0], [2.0, 2.0, 4.0, 4.0])
        source_integral = float(np.sum(values) * source.axial_spacing)
        target_integral = float(np.sum(projected) * target.axial_spacing)
        self.assertAlmostEqual(source_integral, target_integral)

    def test_conservative_projection_rejects_different_support(self) -> None:
        source = _domain((2, 1, 1))
        target = _domain((4, 1, 1))
        source_ref = _domain_ref(source)
        target_ref = _domain_ref(target)
        target_ref["axes"][0]["ticks"] = [tick + 0.25 for tick in target_ref["axes"][0]["ticks"]]
        values = np.asarray([[[2.0]], [[4.0]]])
        field = structured_cell_field(
            source_ref,
            values,
            source_ref["axes"],
            quantity_kind="PowerDensity",
            unit="W.m-3",
        )

        with self.assertRaisesRegex(ValueError, "same region"):
            values_on_structured_grid(field, target_ref)

    def test_heat_source_requires_typed_field_and_legacy_adapter_is_explicit(self) -> None:
        domain = _domain((2, 1, 1))
        domain_ref = _domain_ref(domain)
        values = np.asarray([[[2.0]], [[4.0]]])
        typed = structured_cell_field(
            domain_ref,
            values,
            domain_ref["axes"],
            quantity_kind="PowerDensity",
            unit="W.m-3",
        )

        np.testing.assert_allclose(_volume_source(typed, domain, 2.0, domain_ref), [1.0, 2.0])
        with self.assertRaisesRegex(ValueError, "typed cell field"):
            _volume_source({"value": values}, domain, 2.0, domain_ref)
        legacy = _legacy_heat_source({"value": values}, domain_ref)
        np.testing.assert_allclose(_volume_source(legacy, domain, 2.0, domain_ref), [1.0, 2.0])
        target = _domain((4, 1, 1))
        np.testing.assert_allclose(
            _volume_source(typed, target, 2.0, _domain_ref(target)),
            [1.0, 1.0, 2.0, 2.0],
        )


class SolverOutputTests(unittest.TestCase):
    def test_dc_joule_heating_is_a_typed_field_with_legacy_tensor_keys(self) -> None:
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
        self.assertEqual(field["kind"], STRUCTURED_FIELD_KIND)
        self.assertEqual(field["domainRef"]["id"], domain_ref["id"])
        self.assertIn("value", field)
        self.assertIn("axes", field)

    def test_ray_path_artifact_is_only_added_when_requested(self) -> None:
        bundle = {"vertices": {"value": np.empty((0, 3), dtype=np.float32)}}
        config = {"outputs": [{"methodId": "ray.paths", "key": "paths"}]}
        progress_events: list[object] = []

        async def progress(event: object) -> None:
            progress_events.append(event)

        artifacts = asyncio.run(build_ray_outputs(config, [], 0.0, bundle, progress))

        self.assertEqual(artifacts["paths"]["kind"], RAY_PATH_BUNDLE_KIND)
        self.assertIs(artifacts["paths"]["members"], bundle)
        self.assertNotIn("kind", bundle)
        self.assertEqual(len(progress_events), 1)


if __name__ == "__main__":
    unittest.main()
