from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
import warnings
from caemble_catalog import Catalog
from fastapi import FastAPI

from routers.catalog import router


def test_catalog_openapi_builds_without_warnings():
    app = FastAPI()
    app.include_router(router)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        schema = app.openapi()
    assert "/catalog/runtime-slice" in schema["paths"]
    assert "/catalog/geometries/{key}" in schema["paths"]
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
    assert meta.json()["schemaVersion"] == 2
    assert meta.json()["geometryCount"] == 7
    assert meta.json()["experimentCount"] == 4
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

    dc = await catalog_client.get("/catalog/solvers/dc-current-density/0.1.0")
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
async def test_official_geometries_and_experiments_are_public_filterable_and_cacheable(
    catalog_client: httpx.AsyncClient,
):
    geometries = await catalog_client.get("/catalog/geometries", params={"element": "fiber", "limit": 1})
    assert geometries.status_code == 200
    assert geometries.json()["total"] == 2
    assert geometries.json()["nextCursor"]
    assert geometries.headers["etag"]

    wheel = await catalog_client.get("/catalog/geometries/two-material-wheel-assembly")
    assert wheel.status_code == 200
    assert wheel.json()["exportName"] == "WheelAssembly"
    assert [item["role"] for item in wheel.json()["materialRoles"]] == ["tire", "wheel"]
    assert "export const WheelAssembly" in wheel.json()["source"]

    experiments = await catalog_client.get(
        "/catalog/experiments",
        params={"solverName": "steady-state-heat", "solverVersion": "0.1.0"},
    )
    assert experiments.status_code == 200
    assert [item["key"] for item in experiments.json()["items"]] == ["electro-thermal-uniform-bar"]

    detail = await catalog_client.get("/catalog/experiments/dc-uniform-bar")
    assert detail.status_code == 200, detail.text
    assert detail.json()["sourceBundle"]["formatVersion"] == 5
    assert detail.json()["verification"]["kernelTasks"] == ["solveCurrent"]

    search = await catalog_client.get("/catalog/search", params={"q": "wheel"})
    assert {item["kind"] for item in search.json()["items"]} >= {"geometry"}
    missing = await catalog_client.get("/catalog/experiments/not-real")
    assert missing.status_code == 404


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
