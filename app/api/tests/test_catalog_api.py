from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
import warnings
from caemble_catalog import Catalog
from caemble_catalog.admin import create_draft, insert_experiment, refresh_derived_data, writable_connection
from fastapi import FastAPI

from routers.catalog import router


def test_catalog_openapi_builds_without_warnings():
    app = FastAPI()
    app.include_router(router)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        schema = app.openapi()
    assert "/catalog/runtime-slice" in schema["paths"]
    assert "/catalog/geometries/{key}" not in schema["paths"]
    assert "/catalog/experiments/{key}" in schema["paths"]


@pytest_asyncio.fixture
async def catalog_client():
    app = FastAPI()
    catalog = Catalog.open_readonly()
    app.state.catalog = catalog
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://testserver") as client:
        yield client
    catalog.close()


@pytest.mark.asyncio
async def test_catalog_is_anonymous_cacheable_and_paginated(catalog_client: httpx.AsyncClient):
    meta = await catalog_client.get("/catalog/meta")
    assert meta.status_code == 200
    assert meta.json()["quantityKindCount"] == 1_216
    assert meta.json()["schemaVersion"] == 5
    assert "geometryCount" not in meta.json()
    assert meta.json()["experimentCount"] == 11
    assert meta.json()["materialGlobalQualifiers"][0] == "temperature"
    assert "canonical_key" in meta.json()["materialDesignRules"]
    assert meta.headers["etag"].startswith('"')
    assert meta.headers["cache-control"].startswith("public")

    first = await catalog_client.get("/catalog/quantity-kinds", params={"limit": 1, "unit": "K"})
    assert first.status_code == 200
    assert first.json()["total"] > 1
    assert first.json()["nextCursor"]
    second = await catalog_client.get(
        "/catalog/quantity-kinds", params={"limit": 1, "unit": "K", "cursor": first.json()["nextCursor"]}
    )
    assert second.json()["items"][0]["name"] != first.json()["items"][0]["name"]


@pytest.mark.asyncio
async def test_catalog_relations_and_artifact_compatibility(catalog_client: httpx.AsyncClient):
    quantity = await catalog_client.get("/catalog/quantity-kinds/thermodynamics.Temperature")
    assert quantity.status_code == 200
    assert any(item["solverName"] == "steady-state-heat" for item in quantity.json()["solverUsages"])

    material = await catalog_client.get("/catalog/material-parameters/thermal.conductivity")
    assert material.status_code == 200
    assert material.json()["quantityKindDefinition"]["name"] == "thermodynamics.ThermalConductivity"
    assert material.json()["solverRequirements"][0]["role"] == "thermalDomain"

    dc = await catalog_client.get("/catalog/solvers/dc-current-density/0.2.0")
    joule = next(item for item in dc.json()["producesArtifacts"] if item["artifactType"] == "caemble.dc/joule-heating@1")
    assert joule["consumers"] == [
        {"solverName": "steady-state-heat", "solverVersion": "0.1.0", "inputPort": "heatSource"}
    ]


@pytest.mark.asyncio
async def test_catalog_search_filters_and_errors(catalog_client: httpx.AsyncClient):
    search = await catalog_client.get("/catalog/search", params={"q": "conductivity"})
    assert search.status_code == 200
    assert {item["kind"] for item in search.json()["items"]} >= {"materialParameter"}

    filtered = await catalog_client.get(
        "/catalog/material-parameters",
        params={"solverName": "steady-state-heat", "solverVersion": "0.1.0"},
    )
    assert [item["key"] for item in filtered.json()["items"]] == ["thermal.conductivity"]

    missing = await catalog_client.get("/catalog/material-parameters/not.real")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "catalog_not_found"
    bad_cursor = await catalog_client.get("/catalog/quantity-kinds", params={"cursor": "not-base64!"})
    assert bad_cursor.status_code == 422


@pytest.mark.asyncio
async def test_example_experiments_are_public_filterable_and_cacheable(
    catalog_client: httpx.AsyncClient,
):
    experiments = await catalog_client.get(
        "/catalog/experiments",
        params={
            "solverName": "steady-state-heat",
            "solverVersion": "0.1.0",
            "namespace": "caemble",
            "repository": "verified",
        },
    )
    assert experiments.status_code == 200
    assert [item["key"] for item in experiments.json()["items"]] == ["electro-thermal-uniform-bar"]

    detail = await catalog_client.get(
        "/catalog/experiments/dc-uniform-bar",
        params={"namespace": "caemble", "repository": "verified", "version": "1.0.0"},
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["sourceBundle"]["formatVersion"] == 6
    assert detail.json()["namespace"] == "caemble"
    assert detail.json()["coordinate"].startswith("caemble:experiment/caemble/")
    assert detail.json()["verification"]["kernelTasks"] == ["solveCurrent"]
    assert detail.json()["verification"]["fixture"]["records"][0]["name"] == "totalCurrent"

    fiber = await catalog_client.get(
        "/catalog/experiments/fiber-bundle",
        params={"namespace": "caemble", "repository": "advanced-shapes", "version": "1.0.0"},
    )
    assert fiber.status_code == 200, fiber.text
    assert fiber.json()["verification"]["fixture"]["records"] == [
        {
            "name": "currentDensity",
            "dtype": "float64",
            "shape": [31, 31, 3],
            "finite": True,
            "nonzero": True,
        },
        {
            "name": "totalCurrent",
            "dtype": "float64",
            "shape": [],
            "finite": True,
            "minimumExclusive": 0.0,
        },
    ]

    for key in ("dc-notched-current-density", "dc-resolution-study", "electro-thermal-uniform-bar"):
        without_fixture = await catalog_client.get(f"/catalog/experiments/{key}")
        assert without_fixture.status_code == 200, without_fixture.text
        assert without_fixture.json()["verification"]["fixture"] is None

    search = await catalog_client.get("/catalog/search", params={"q": "uniform"})
    assert {item["kind"] for item in search.json()["items"]} >= {"experiment"}
    missing = await catalog_client.get("/catalog/experiments/not-real")
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_experiment_detail_requires_full_identity_when_key_is_ambiguous(tmp_path):
    draft = tmp_path / "catalog.sqlite3"
    create_draft(draft)
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        duplicate = {**catalog.experiment("basketball-goal"), "version": "2.0.0"}
    with writable_connection(draft) as connection:
        insert_experiment(connection, duplicate)
    refresh_derived_data(draft)

    app = FastAPI()
    catalog = Catalog.open_readonly(draft, immutable=False)
    app.state.catalog = catalog
    app.include_router(router)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://testserver"
        ) as client:
            ambiguous = await client.get("/catalog/experiments/basketball-goal")
            assert ambiguous.status_code == 409
            assert ambiguous.json()["detail"]["code"] == "catalog_ambiguous"
            selected = await client.get(
                "/catalog/experiments/basketball-goal",
                params={
                    "namespace": "caemble",
                    "repository": "getting-started",
                    "version": "2.0.0",
                },
            )
            assert selected.status_code == 200
            assert selected.json()["coordinate"].endswith("@2.0.0")
    finally:
        catalog.close()


@pytest.mark.asyncio
async def test_runtime_slice_returns_only_solver_closure_and_explicit_points(catalog_client: httpx.AsyncClient):
    response = await catalog_client.post(
        "/catalog/runtime-slice",
        json={
            "solvers": [{"name": "steady-state-heat", "version": "0.1.0"}],
            "quantityKinds": ["Absorptance"],
            "materialParameters": ["general.mass_density"],
            "materialModels": ["model.sorption.isotherm"],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["schemaVersion"] == 1
    assert body["solvers"][0]["contractDigest"]
    assert {item["key"] for item in body["materialParameters"]} == {
        "general.mass_density",
        "thermal.conductivity",
    }
    assert body["materialModels"][0]["key"] == "model.sorption.isotherm"
    assert body["materialGlobalQualifiers"][0] == "temperature"
    assert any("valid but unused" in warning for warning in body["warnings"])

    missing = await catalog_client.post(
        "/catalog/runtime-slice",
        json={"solvers": [{"name": "missing", "version": "1"}]},
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "catalog_not_found"


@pytest.mark.asyncio
async def test_runtime_slice_enforces_request_limits(catalog_client: httpx.AsyncClient):
    response = await catalog_client.post(
        "/catalog/runtime-slice",
        json={"quantityKinds": [f"q{index}" for index in range(257)]},
    )
    assert response.status_code == 422
