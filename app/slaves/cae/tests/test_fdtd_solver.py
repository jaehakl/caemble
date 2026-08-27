from __future__ import annotations

import importlib
from typing import Any

import numpy as np
import pytest

from app.methods.geometry import GeometryService
from app.runtime_kernel.api import SolverImplementation, SolverInvocation, StructuredBundle
from app.runtime_kernel.catalog import SolverCatalog
from app.solvers.fdtd.v1_0_0 import formulation


def _box_root(
    root_id: str,
    size: tuple[float, float, float],
    *,
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    material: str | None = None,
) -> dict[str, Any]:
    primitive: dict[str, Any] = {
        "kind": "primitive",
        "nodeId": f"{root_id}-box",
        "primitive": "box",
        "parameters": {"size": list(size)},
    }
    node = primitive
    if center != (0.0, 0.0, 0.0):
        node = {
            "kind": "transform",
            "nodeId": f"{root_id}-transform",
            "matrix": [
                1.0,
                0.0,
                0.0,
                center[0],
                0.0,
                1.0,
                0.0,
                center[1],
                0.0,
                0.0,
                1.0,
                center[2],
                0.0,
                0.0,
                0.0,
                1.0,
            ],
            "child": primitive,
        }
    root: dict[str, Any] = {"id": root_id, "node": node}
    if material is not None:
        root.update(materialRole="body", material={"name": material})
    return root


def _material_value(value: float | list[float], unit: str) -> dict[str, Any]:
    return {"value": {"dtype": "float64", "value": value, "unit": unit}}


@pytest.mark.asyncio
async def test_catalog_fdtd_abi2_runs_small_cpu_domain_with_mixed_drude_materials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = SolverCatalog.discover()
    descriptor = catalog.descriptor("fdtd", "1.0.0")
    locator = catalog.locator("fdtd", "1.0.0")
    assert catalog.abi_version("fdtd", "1.0.0") == 2
    assert locator == "app.solvers.fdtd.v1_0_0.entry:implementation"

    module_name, attribute = locator.split(":", maxsplit=1)
    implementation = getattr(importlib.import_module(module_name), attribute)
    assert isinstance(implementation, SolverImplementation)
    assert implementation.abi_version == 2

    main_size = (4.0, 4.0, 4.0)
    task_roots = [
        _box_root("buffer", (12.0, 12.0, 12.0), material="Buffer Background"),
        _box_root("main", main_size, material="Main Background"),
        _box_root("source", (2.0, 2.0, 2.0), center=(-1.0, 0.0, 0.0)),
        _box_root("detector", (2.0, 4.0, 4.0), center=(1.0, 0.0, 0.0)),
    ]
    experiment_roots = [
        _box_root("drude", (2.0, 4.0, 4.0), material="Drude Medium"),
        _box_root(
            "later-dielectric",
            (1.0, 1.0, 1.0),
            center=(0.5, 0.5, 0.5),
            material="Later Dielectric",
        ),
    ]
    task_scene = {
        "geometryHash": "fdtd-task-integration-v1",
        "lengthUnit": "m",
        "roots": task_roots,
        "geometryGroups": [
            {"name": "main", "rootIds": ["main"]},
            {"name": "buffer", "rootIds": ["buffer"]},
            {"name": "source", "rootIds": ["source"]},
            {"name": "detector", "rootIds": ["detector"]},
        ],
        "surfaceGroups": [],
    }
    experiment_scene = {
        "geometryHash": "fdtd-experiment-integration-v1",
        "lengthUnit": "m",
        "roots": experiment_roots,
        "geometryGroups": [{"name": "materials", "rootIds": ["drude", "later-dielectric"]}],
        "surfaceGroups": [],
    }
    identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    world = {
        "experiment": experiment_scene,
        "task": task_scene,
        "materials": {
            "task": {
                "parameters": {
                    "materials": {
                        "Main Background": {
                            "electrical.relative_permittivity": _material_value(identity, "{fraction}")
                        },
                        "Buffer Background": {
                            "electrical.relative_permittivity": _material_value(
                                [2.0 * value for value in identity], "{fraction}"
                            )
                        },
                    }
                },
                "warnings": [],
            },
            "experiment": {
                "parameters": {
                    "materials": {
                        "Drude Medium": {
                            "electrical.relative_permittivity": _material_value(
                                [2.0 * value for value in identity], "{fraction}"
                            ),
                            "electrical.drude_infinite_frequency_relative_permittivity": (
                                _material_value(identity, "{fraction}")
                            ),
                            "electrical.drude_plasma_frequency": _material_value(5e7, "Hz"),
                            "electrical.drude_collision_frequency": _material_value(1e7, "Hz"),
                        },
                        "Later Dielectric": {
                            "electrical.relative_permittivity": _material_value(
                                [4.0 * value for value in identity], "{fraction}"
                            )
                        },
                    }
                },
                "warnings": [],
            },
        },
    }
    config = {
        "parameters": {
            "periodicX": False,
            "periodicY": False,
            "periodicZ": False,
            "simulationTime": {"value": 4e-8},
            "pmlType": "cpml",
            "pmlThickness": {"value": 1.0},
            "pmlCellSize": {"value": 1.0},
            "pmlCenterWavelength": {"value": 10.0},
        },
        "initializations": [
            {
                "methodId": "fdtd.main-region",
                "target": ["task.geometry.main"],
                "parameters": {
                    "cellSizeX": {"value": 1.0},
                    "cellSizeY": {"value": 1.0},
                    "cellSizeZ": {"value": 1.0},
                    "model": "Drude_RC",
                },
            },
            {
                "methodId": "fdtd.buffer-region",
                "target": ["task.geometry.buffer"],
                "parameters": {"cellSize": {"value": 2.0}, "model": "default"},
            },
        ],
        "boundaryConditions": [
            {
                "methodId": "fdtd.soft-electric-source",
                "target": ["task.geometry.source"],
                "parameters": {
                    "waveform": "gaussian",
                    "amplitude": {"value": [0.0, 0.0, 1.0]},
                    "frequency": {"value": 5e7},
                    "bandwidth": {"value": 2e8},
                    "startTime": {"value": 0.0},
                    "endTime": {"value": 4e-8},
                },
            }
        ],
        "outputs": [
            {
                "methodId": "fdtd.time-electric-field",
                "key": "timeElectric",
                "target": ["task.geometry.detector"],
                "parameters": {"strideX": 1, "strideY": 2, "strideZ": 2, "timeStride": 2},
            },
            {
                "methodId": "fdtd.spectral-magnetic-field",
                "key": "spectralMagnetic",
                "target": ["task.geometry.detector"],
                "parameters": {
                    "strideX": 1,
                    "strideY": 2,
                    "strideZ": 2,
                    "frequencyStart": {"value": 5e7},
                    "frequencyStop": {"value": 5e7},
                    "frequencyStep": {"value": 1e7},
                },
            },
        ],
    }
    invocation = SolverInvocation(
        config=config,
        state={},
        inputs={},
        world=world,
        geometry=GeometryService(),
        progress=None,
        descriptor=descriptor,
        task_name="fdtd-integration",
    )

    captured: dict[str, Any] = {}
    original_prepare_domain = formulation.prepare_domain

    async def capture_prepared_domain(value: SolverInvocation) -> Any:
        prepared = await original_prepare_domain(value)
        captured["prepared"] = prepared
        return prepared

    monkeypatch.setattr(formulation, "prepare_domain", capture_prepared_domain)
    result = await implementation(invocation)
    prepared = captured["prepared"]

    x_ticks, y_ticks, z_ticks = (
        np.asarray(axis, dtype=np.float64) for axis in prepared.domain.cell_ticks
    )
    drude_index = (
        int(np.argmin(np.abs(z_ticks + 0.5))),
        int(np.argmin(np.abs(y_ticks + 0.5))),
        int(np.argmin(np.abs(x_ticks + 0.5))),
    )
    later_index = (
        int(np.argmin(np.abs(z_ticks - 0.5))),
        int(np.argmin(np.abs(y_ticks - 0.5))),
        int(np.argmin(np.abs(x_ticks - 0.5))),
    )
    background_index = (
        int(np.argmin(np.abs(z_ticks - 1.5))),
        int(np.argmin(np.abs(y_ticks - 1.5))),
        int(np.argmin(np.abs(x_ticks - 1.5))),
    )
    assert prepared.relative_permittivity[drude_index] == pytest.approx(2.0)
    assert prepared.epsilon_infinity[drude_index] == pytest.approx(1.0)
    assert prepared.plasma_frequency[drude_index] == pytest.approx(5e7)
    assert prepared.relative_permittivity[later_index] == pytest.approx(4.0)
    assert np.isnan(prepared.epsilon_infinity[later_index])
    assert np.isnan(prepared.plasma_frequency[later_index])
    assert prepared.relative_permittivity[background_index] == pytest.approx(1.0)
    assert np.isnan(prepared.epsilon_infinity[background_index])

    assert result.state_patch.is_empty
    assert result.observations["device"] == "cpu"
    assert 0 < result.observations["totalCells"] < 100_000
    assert result.observations["timeSteps"] > 0
    assert "pmlCellSize exceeds pmlCenterWavelength/15" in result.observations[
        "pmlResolutionWarning"
    ]

    output_contracts = {
        method["methodId"]: method
        for method in descriptor["methods"]["outputs"]
    }
    time_bundle = result.artifacts["timeElectric"]
    assert isinstance(time_bundle, StructuredBundle)
    assert time_bundle.bundle_type == output_contracts["fdtd.time-electric-field"]["artifactType"]
    assert set(time_bundle.members) == {"field"}
    time_field = time_bundle.members["field"]
    time_steps = result.observations["timeSteps"]
    expected_time_samples = 1 + time_steps // 2 + int(time_steps % 2 != 0)
    assert time_field["value"].shape == (expected_time_samples, 2, 2, 2, 3)
    assert time_field["value"].dtype == np.float32
    assert [axis["name"] for axis in time_field["axes"]] == ["time", "z", "y", "x"]
    assert all(np.asarray(axis["ticks"]).dtype == np.float64 for axis in time_field["axes"])
    assert np.all(np.isfinite(time_field["value"]))
    assert np.any(np.abs(time_field["value"]) > 0)
    time_contract = output_contracts["fdtd.time-electric-field"]["data"]["members"]["field"]
    assert time_field["quantityKind"] == time_contract["quantityKind"]
    assert time_field["unit"] == time_contract["unit"]

    spectral_bundle = result.artifacts["spectralMagnetic"]
    assert isinstance(spectral_bundle, StructuredBundle)
    assert (
        spectral_bundle.bundle_type
        == output_contracts["fdtd.spectral-magnetic-field"]["artifactType"]
    )
    assert set(spectral_bundle.members) == {"real", "imag"}
    spectral_contract = output_contracts["fdtd.spectral-magnetic-field"]["data"]["members"]
    for name in ("real", "imag"):
        member = spectral_bundle.members[name]
        assert member["value"].shape == (1, 2, 2, 2, 3)
        assert member["value"].dtype == np.float32
        assert [axis["name"] for axis in member["axes"]] == ["frequency", "z", "y", "x"]
        assert np.asarray(member["axes"][0]["ticks"]) == pytest.approx([5e7])
        assert np.all(np.isfinite(member["value"]))
        assert member["quantityKind"] == spectral_contract[name]["quantityKind"]
        assert member["unit"] == spectral_contract[name]["unit"]
    assert np.any(np.abs(spectral_bundle.members["real"]["value"]) > 0)
    assert any(
        block.kind == "buffer" for block in prepared.domain.blocks.values()
    )
    assert all(
        block.model == prepared.domain.blocks[block.inherited_from].model
        and block.background is prepared.domain.blocks[block.inherited_from].background
        for block in prepared.domain.blocks.values()
        if block.kind == "pml"
    )
