import hashlib
import json

import pytest

from db import Experiment, ExperimentNamespace
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle


pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def create_payload(
    bundle: dict,
    *,
    namespace: str = "experiment-old",
    repository: str = "examples",
    key: str = "beam",
) -> dict:
    return {
        "mode": "create",
        "namespace": namespace,
        "repository": repository,
        "key": key,
        "initialVersion": "0.1.0",
        "name": "Experiment",
        "description": None,
        "sourceBundle": bundle,
        "bundleHash": bundle_hash(bundle),
    }


@pytest.mark.asyncio
async def test_experiment_identity_change_updates_all_versions_and_namespace_ownership(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    headers = auth_headers(owner)
    bundle = experiment_source_bundle()
    saved = await client.post("/experiment/save", headers=headers, json=create_payload(bundle))
    assert saved.status_code == 200, saved.text
    assert saved.json()["coordinate"].startswith("caemble:experiment/experiment-old/")
    me = await client.get("/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["experiment_namespaces"] == ["experiment-old"]

    versioned = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "mode": "new_version",
            "experimentId": saved.json()["id"],
            "baseBundleHash": saved.json()["bundleHash"],
            "bump": "minor",
            "namespace": "experiment-new",
            "repository": "renamed-repository",
            "key": "renamed-key",
            "name": "Experiment vNext",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert versioned.status_code == 200, versioned.text
    assert versioned.json()["version"] == "0.2.0"
    assert versioned.json()["namespace"] == "experiment-new"
    assert versioned.json()["coordinate"].startswith(
        "caemble:experiment/experiment-new/renamed-repository/renamed-key@"
    )
    versions = await client.get(f"/experiment/{saved.json()['id']}/versions", headers=headers)
    assert versions.status_code == 200
    assert len(versions.json()["items"]) == 2
    assert {
        (item["namespace"], item["repository"], item["key"])
        for item in versions.json()["items"]
    } == {("experiment-new", "renamed-repository", "renamed-key")}
    assert await db_session.get(ExperimentNamespace, "experiment-old") is None
    namespace_owner = await db_session.get(ExperimentNamespace, "experiment-new")
    assert namespace_owner is not None and namespace_owner.user_id == owner.id

    conflict = await client.post(
        "/experiment/save",
        headers=auth_headers(other),
        json=create_payload(bundle, namespace="experiment-new", key="other-key"),
    )
    assert conflict.status_code == 409
    reserved = await client.post(
        "/experiment/save",
        headers=headers,
        json=create_payload(bundle, namespace="caemble"),
    )
    assert reserved.status_code == 409


@pytest.mark.asyncio
async def test_namespace_lifetime_and_failed_rename_are_atomic(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    bundle = experiment_source_bundle()
    invalid_version = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            **create_payload(bundle, namespace="rolled-back-space", key="invalid-version"),
            "initialVersion": "2147483648.0.0",
        },
    )
    assert invalid_version.status_code == 422
    assert await db_session.get(ExperimentNamespace, "rolled-back-space") is None
    first = await client.post(
        "/experiment/save",
        headers=headers,
        json=create_payload(bundle, namespace="family-space", key="first"),
    )
    first_version = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "mode": "new_version",
            "experimentId": first.json()["id"],
            "baseBundleHash": first.json()["bundleHash"],
            "bump": "patch",
            "namespace": "family-space",
            "repository": "examples",
            "key": "first",
            "name": "First patch",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    second = await client.post(
        "/experiment/save",
        headers=headers,
        json=create_payload(bundle, namespace="family-space", key="second"),
    )
    other_space = await client.post(
        "/experiment/save",
        headers=headers,
        json=create_payload(bundle, namespace="other-space", key="third"),
    )
    assert first.status_code == first_version.status_code == second.status_code == other_space.status_code == 200
    me = await client.get("/auth/me", headers=headers)
    assert me.json()["experiment_namespaces"] == ["family-space", "other-space"]
    removed_other = await client.request(
        "DELETE",
        "/experiment/",
        headers=headers,
        json=[other_space.json()["id"]],
    )
    assert removed_other.status_code == 200
    assert await db_session.get(ExperimentNamespace, "other-space") is None

    target_conflict = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "mode": "overwrite",
            "experimentId": first.json()["id"],
            "baseBundleHash": first.json()["bundleHash"],
            "namespace": "family-space",
            "repository": "examples",
            "key": "second",
            "name": "Conflicting rename",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert target_conflict.status_code == 409

    conflict = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "mode": "overwrite",
            "experimentId": first.json()["id"],
            "baseBundleHash": "f" * 64,
            "namespace": "unclaimed-space",
            "repository": "examples",
            "key": "new-key",
            "name": "Stale rename",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert conflict.status_code == 409
    assert await db_session.get(ExperimentNamespace, "unclaimed-space") is None
    db_session.expire_all()
    persisted = await db_session.get(Experiment, first.json()["id"])
    assert persisted is not None
    assert (persisted.namespace, persisted.repository_slug, persisted.experiment_key) == (
        "family-space",
        "examples",
        "first",
    )

    partial = await client.request(
        "DELETE",
        "/experiment/",
        headers=headers,
        json=[first.json()["id"]],
    )
    assert partial.status_code == 200
    assert await db_session.get(ExperimentNamespace, "family-space") is not None
    remaining = await client.request(
        "DELETE",
        "/experiment/",
        headers=headers,
        json=[second.json()["id"]],
    )
    assert remaining.status_code == 200
    assert await db_session.get(ExperimentNamespace, "family-space") is not None
    final = await client.request(
        "DELETE",
        "/experiment/",
        headers=headers,
        json=[first_version.json()["id"]],
    )
    assert final.status_code == 200
    assert await db_session.get(ExperimentNamespace, "family-space") is None


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
