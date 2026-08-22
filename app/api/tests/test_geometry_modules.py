import hashlib
import json

import pytest

from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle


pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def create_payload(bundle: dict, *, repository: str = "examples", key: str = "beam") -> dict:
    return {
        "mode": "create",
        "repository": repository,
        "key": key,
        "initialVersion": "0.1.0",
        "name": "Experiment",
        "description": None,
        "sourceBundle": bundle,
        "bundleHash": bundle_hash(bundle),
    }


@pytest.mark.asyncio
async def test_experiment_namespace_changes_preserve_historical_coordinates(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    headers = auth_headers(owner)
    changed = await client.put(
        "/auth/experiment-namespace",
        headers=headers,
        json={"namespace": "experiment-old"},
    )
    assert changed.status_code == 200, changed.text
    bundle = experiment_source_bundle()
    saved = await client.post("/experiment/save", headers=headers, json=create_payload(bundle))
    assert saved.status_code == 200, saved.text
    assert saved.json()["coordinate"].startswith("caemble:experiment/experiment-old/")

    changed = await client.put(
        "/auth/experiment-namespace",
        headers=headers,
        json={"namespace": "experiment-new"},
    )
    assert changed.status_code == 200, changed.text
    versioned = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "mode": "new_version",
            "experimentId": saved.json()["id"],
            "baseBundleHash": saved.json()["bundleHash"],
            "bump": "minor",
            "name": "Experiment vNext",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert versioned.status_code == 200, versioned.text
    assert versioned.json()["version"] == "0.2.0"
    assert versioned.json()["namespace"] == "experiment-old"

    conflict = await client.put(
        "/auth/experiment-namespace",
        headers=auth_headers(other),
        json={"namespace": "experiment-old"},
    )
    assert conflict.status_code == 409
    reserved = await client.put(
        "/auth/experiment-namespace",
        headers=headers,
        json={"namespace": "caemble"},
    )
    assert reserved.status_code == 409


@pytest.mark.asyncio
async def test_bundle_v6_accepts_extra_relative_modules_and_optional_tasks(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    bundle = experiment_source_bundle()
    bundle["files"].pop("tasks/main.tsx")
    bundle["files"]["geometry.tsx"] = "export { Shape } from './modules/shape'\n"
    bundle["files"]["modules/shape.tsx"] = "export const Shape = () => <box />\n"
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json=create_payload(bundle),
    )
    assert response.status_code == 200, response.text
    assert response.json()["sourceLocked"] is False


@pytest.mark.asyncio
async def test_bundle_v6_rejects_runtime_cycles_and_casefold_collisions(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    cycle = experiment_source_bundle()
    cycle["files"]["geometry.tsx"] = "import './modules/a'\nexport {}\n"
    cycle["files"]["modules/a.ts"] = "import '../geometry'\n"
    response = await client.post("/experiment/save", headers=headers, json=create_payload(cycle))
    assert response.status_code == 422

    collision = experiment_source_bundle()
    collision["files"]["modules/Part.ts"] = "export {}\n"
    collision["files"]["modules/part.ts"] = "export {}\n"
    response = await client.post(
        "/experiment/save",
        headers=headers,
        json=create_payload(collision, key="collision"),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_geometry_management_routes_are_removed(client):
    assert (await client.get("/geometry/repositories")).status_code == 404
    assert (await client.get("/catalog/geometries")).status_code == 404
