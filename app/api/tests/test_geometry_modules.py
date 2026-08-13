import hashlib
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, event, func, select, update
from sqlalchemy.exc import DBAPIError

from db import (
    Experiment,
    ExperimentGeometryModule,
    ExperimentGeometryRoot,
    GeometryImport,
    GeometryPackage,
    GeometryRepository,
    GeometryVersion,
)
from models import ExperimentSourceBundle, GeometryPublishPlanRequest, GeometrySnapshot
from service.geometry.graph import _assert_max_depth, validate_snapshot
from service.geometry.publish import _validate_publish_request
from service.geometry.source import (
    _bump,
    _version_tuple,
    analyze_geometry_source,
    module_hash,
    source_hash,
)
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle
from user_auth.db import User
from user_auth.utils.jwt import make_access, make_refresh


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def geometry_source(*imports: str, label: str = "plate") -> str:
    lines = ['import { box } from "@caemble/core";']
    lines.extend(
        f'import dependency{index} from "{coordinate}";'
        for index, coordinate in enumerate(imports)
    )
    children = "".join(f"{{dependency{index}}}" for index in range(len(imports)))
    lines.append(f'export default <geometry id="{label}"><box size={{[1, 1, 1]}} />{children}</geometry>;')
    return "\n".join(lines)


async def set_namespace(client, user, namespace: str):
    response = await client.put(
        "/auth/geometry-namespace",
        headers=auth_headers(user),
        json={"namespace": namespace},
    )
    assert response.status_code == 200, response.text
    return response


async def plan_and_publish(client, user, payload: dict) -> dict:
    plan = await client.post("/geometry/publish/plan", headers=auth_headers(user), json=payload)
    assert plan.status_code == 200, plan.text
    published = await client.post(
        "/geometry/publish",
        headers=auth_headers(user),
        json={**payload, "planHash": plan.json()["planHash"]},
    )
    assert published.status_code == 200, published.text
    return published.json()


@pytest.mark.asyncio
async def test_geometry_namespace_can_change_and_remains_unique(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    first = await create_user(db_session)
    second = await create_user(db_session)
    first_headers = auth_headers(first)
    response = await set_namespace(client, first, "first-user")
    assert response.json()["geometry_namespace"] == "first-user"
    same = await set_namespace(client, first, "first-user")
    assert same.json()["geometry_namespace"] == "first-user"
    changed = await client.put(
        "/auth/geometry-namespace",
        headers=first_headers,
        json={"namespace": "other-user"},
    )
    duplicate = await client.put(
        "/auth/geometry-namespace",
        headers=auth_headers(second),
        json={"namespace": "other-user"},
    )
    assert changed.status_code == 200
    assert changed.json()["geometry_namespace"] == "other-user"
    assert duplicate.status_code == 409
    returned = await client.put(
        "/auth/geometry-namespace",
        headers=first_headers,
        json={"namespace": "first-user"},
    )
    assert returned.status_code == 200, returned.text
    assert returned.json()["geometry_namespace"] == "first-user"


@pytest.mark.asyncio
async def test_namespace_change_preserves_history_and_repository_id_selects_old_namespace(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "history-old")
    initial = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-and-apply",
            "targetDraftId": "base",
            "drafts": [{
                "draftId": "base",
                "repository": "common",
                "package": "base",
                "version": "1.0.0",
                "source": geometry_source(label="base"),
            }],
            "currentRoots": [{"alias": "base", "draftId": "base"}],
        },
    )
    original_version = initial["published"][0]
    original_snapshot = initial["geometrySnapshot"]
    bundle = {
        **experiment_source_bundle(),
        "formatVersion": 3,
        "geometrySnapshot": original_snapshot,
    }
    saved = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Namespace invariant",
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert saved.status_code == 200, saved.text
    repository = await db_session.scalar(
        select(GeometryRepository).where(GeometryRepository.namespace == "history-old")
    )
    repository_id = repository.id

    await set_namespace(client, owner, "history-new")
    resolved = await client.get(
        f'/geometry/versions/{original_version["id"]}/resolve',
        headers=auth_headers(owner),
    )
    persisted_experiment = await db_session.get(Experiment, saved.json()["id"])
    assert resolved.status_code == 200
    assert resolved.json()["modules"] == original_snapshot["modules"]
    assert persisted_experiment.source_bundle == bundle
    assert resolved.json()["root"]["moduleHash"] == original_version["moduleHash"]

    bumped = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "base-next",
            "drafts": [{
                "draftId": "base-next",
                "baseGeometryVersionId": original_version["id"],
                "repositoryId": repository_id,
                "repository": "common",
                "package": "base",
                "bump": "patch",
                "source": geometry_source(label="base-next"),
            }],
            "currentRoots": [],
        },
    )
    old_repository_package = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "legacy-package",
            "drafts": [{
                "draftId": "legacy-package",
                "repositoryId": repository_id,
                "repository": "common",
                "package": "legacy-package",
                "version": "1.0.0",
                "source": geometry_source(label="legacy-package"),
            }],
            "currentRoots": [],
        },
    )
    current_repository_package = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "current-package",
            "drafts": [{
                "draftId": "current-package",
                "repository": "common",
                "package": "current-package",
                "version": "1.0.0",
                "source": geometry_source(label="current-package"),
            }],
            "currentRoots": [],
        },
    )
    assert bumped["published"][0]["coordinate"].startswith(
        "caemble:geometry/history-old/common/base@"
    )
    assert old_repository_package["published"][0]["coordinate"].startswith(
        "caemble:geometry/history-old/common/legacy-package@"
    )
    assert current_repository_package["published"][0]["coordinate"].startswith(
        "caemble:geometry/history-new/common/current-package@"
    )
    repositories = await client.post(
        "/geometry/repositories/list",
        headers=auth_headers(owner),
        json={
            "scope": "mine",
            "limit": None,
            "text_filter": {"slug": ["common"]},
            "sort": [["namespace", "asc"], ["slug", "asc"]],
        },
    )
    assert [(item["namespace"], item["slug"]) for item in repositories.json()["items"]] == [
        ("history-new", "common"),
        ("history-old", "common"),
    ]
    returned = await set_namespace(client, owner, "history-old")
    assert returned.json()["geometry_namespace"] == "history-old"


@pytest.mark.asyncio
async def test_cookie_authenticated_geometry_mutations_require_csrf(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "csrf-user")
    client.cookies.set("access_token", make_access(owner))
    client.cookies.set("refresh_token", make_refresh(str(owner.id)))
    payload = {
        "mode": "publish-only",
        "targetDraftId": "root",
        "drafts": [{
            "draftId": "root",
            "repository": "common",
            "package": "root",
            "version": "1.0.0",
            "source": geometry_source(label="root"),
        }],
        "currentRoots": [],
    }

    rejected = await client.post("/geometry/publish/plan", json=payload)
    rejected_with_bearer_header = await client.post(
        "/geometry/publish/plan",
        headers={"Authorization": "Bearer not-the-cookie-principal"},
        json=payload,
    )
    csrf = await client.get("/web/auth/csrf")
    accepted = await client.post(
        "/geometry/publish/plan",
        headers={"X-CSRF-Token": csrf.json()["csrf_token"]},
        json=payload,
    )

    assert rejected.status_code == 403
    assert rejected_with_bearer_header.status_code == 403
    assert accepted.status_code == 200, accepted.text


@pytest.mark.asyncio
async def test_repository_create_archive_and_duplicate_contract(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "repository-user")
    headers = auth_headers(owner)
    created = await client.post(
        "/geometry/repositories",
        headers=headers,
        json={"slug": "parts", "description": "부품 저장소"},
    )
    assert created.status_code == 200
    assert created.json()["description"] == "부품 저장소"
    duplicate = await client.post(
        "/geometry/repositories",
        headers=headers,
        json={"slug": "parts"},
    )
    assert duplicate.status_code == 409
    archived = await client.post(
        f'/geometry/repositories/{created.json()["id"]}/archive',
        headers=headers,
    )
    assert archived.status_code == 200
    assert archived.json()["archivedAt"] is not None
    list_request = {
        "scope": "mine",
        "offset": 0,
        "limit": None,
        "selected_ids": [],
        "search_text": None,
        "text_filter": {},
        "filter": {},
        "null_filter": {"archived_at": "is_null"},
        "sort": ["updated_at", "desc"],
    }
    assert (
        await client.post("/geometry/repositories/list", headers=headers, json=list_request)
    ).json()["items"] == []
    assert len(
        (
            await client.post(
                "/geometry/repositories/list",
                headers=headers,
                json={**list_request, "null_filter": {}},
            )
        ).json()["items"]
    ) == 1


@pytest.mark.asyncio
async def test_manager_package_list_paginates_searches_and_scopes_admin_owner_filter(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    first = await create_user(db_session)
    second = await create_user(db_session)
    admin = await create_user(db_session, "admin")
    await set_namespace(client, first, "list-owner-a")
    await set_namespace(client, second, "list-owner-b")
    for package_name in ["zeta", "alpha"]:
        await plan_and_publish(
            client,
            first,
            {
                "mode": "publish-only",
                "targetDraftId": package_name,
                "drafts": [{
                    "draftId": package_name,
                    "repository": "parts",
                    "package": package_name,
                    "version": "1.0.0",
                    "source": geometry_source(label=package_name),
                }],
                "currentRoots": [],
            },
        )
    await plan_and_publish(
        client,
        second,
        {
            "mode": "publish-only",
            "targetDraftId": "beta",
            "drafts": [{
                "draftId": "beta",
                "repository": "parts",
                "package": "beta",
                "version": "1.0.0",
                "source": geometry_source(label="beta"),
            }],
            "currentRoots": [],
        },
    )
    request = {
        "scope": "visible",
        "offset": 0,
        "limit": 1,
        "search_text": "list-owner-a",
        "text_filter": {"owner_id": [str(first.id)]},
        "null_filter": {"repository_archived_at": "is_null"},
        "sort": [["name", "asc"], ["id", "asc"]],
    }
    first_page = await client.post(
        "/geometry/packages/list",
        headers=auth_headers(admin),
        json=request,
    )
    second_page = await client.post(
        "/geometry/packages/list",
        headers=auth_headers(admin),
        json={**request, "offset": 1},
    )
    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["total"] == 2
    assert [item["name"] for item in first_page.json()["items"]] == ["alpha"]
    assert [item["name"] for item in second_page.json()["items"]] == ["zeta"]

    inaccessible_owner_filter = await client.post(
        "/geometry/packages/list",
        headers=auth_headers(first),
        json={
            **request,
            "limit": None,
            "search_text": None,
            "text_filter": {"owner_id": [str(second.id)]},
        },
    )
    assert inaccessible_owner_filter.status_code == 200
    assert inaccessible_owner_filter.json()["items"] == []


def test_tree_sitter_geometry_analysis_and_hash_contract():
    coordinate = "caemble:geometry/test-user/common/plate@1.2.3"
    source = geometry_source(coordinate)
    assert [item[0] for item in analyze_geometry_source(source)] == [coordinate]
    digest = source_hash(source)
    expected = hashlib.sha256(
        json.dumps(
            {
                "schemaVersion": 1,
                "moduleFormatVersion": 1,
                "cadApiVersion": 5,
                "coordinate": "caemble:geometry/test-user/common/bracket@2.0.0",
                "sourceHash": digest,
                "imports": [{"coordinate": coordinate, "moduleHash": "a" * 64}],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert module_hash(
        "caemble:geometry/test-user/common/bracket@2.0.0",
        digest,
        [{"coordinate": coordinate, "moduleHash": "a" * 64}],
    ) == expected
    assert module_hash(
        "caemble:geometry/jlee/demo/root@2.0.0",
        "c" * 64,
        [
            {
                "coordinate": "caemble:geometry/jlee/demo/root@2.0.0",
                "moduleHash": "b" * 64,
            },
            {
                "coordinate": "caemble:geometry/jlee/demo/leaf@1.0.0",
                "moduleHash": "a" * 64,
            },
        ],
    ) == "9c7fd9aa3ebdaa0e32c81e8e6479de0dfed0a80a34c31370f84df3ee8dfb792b"
    with pytest.raises(Exception, match="exact same-owner coordinate"):
        analyze_geometry_source('import x from "./x"; export default x;')
    with pytest.raises(Exception, match="Dynamic import"):
        analyze_geometry_source('export default import("caemble:geometry/test-user/common/plate@1.2.3");')


@pytest.mark.parametrize(
    ("source", "message"),
    [
        ('import { x } from "caemble:geometry/test-user/common/x@1.0.0"; export default x;', "default import"),
        ('import x from "caemble:geometry/test-user/common/x@latest"; export default x;', "exact same-owner"),
        ('export { x } from "@caemble/core"; export default null;', "only export one default"),
        ('const x = require("@caemble/core"); export default x;', "Dynamic import"),
        ('import core from "@caemble/core"; export default core;', "named or type"),
        ('export default Math.random();', "Math.random"),
        ('export default new Date();', "nondeterminism"),
        ('const deterministic = Math; export default deterministic.random();', "Aliasing Math"),
        ('export default window.location;', "Global runtime access"),
        ('clearTimeout(1); export default null;', "clearTimeout"),
        ('clearInterval(1); export default null;', "clearInterval"),
        ('export default new Worker("worker.js");', "Worker"),
        ('export default new SharedWorker("worker.js");', "SharedWorker"),
        ('export default new XMLHttpRequest();', "XMLHttpRequest"),
        ('export default new WebSocket("ws://example.com");', "WebSocket"),
        ('export default global.process;', "Global runtime access"),
        ('export default Function("return 1")();', "nondeterminism"),
        ('export default ({})["constructor"];', "Prototype access"),
        ('export default {Date};', "Global runtime access"),
        ('export default function build() { return null; }', "Geometry-compatible"),
    ],
)
def test_tree_sitter_geometry_analysis_rejects_unsupported_module_forms(source, message):
    with pytest.raises(Exception, match=message):
        analyze_geometry_source(source)


def test_tree_sitter_geometry_analysis_rejects_unbounded_coordinate_without_integer_conversion():
    coordinate = f"caemble:geometry/test-user/common/part@{'9' * 5_000}.0.0"
    with pytest.raises(Exception, match="must not exceed"):
        analyze_geometry_source(geometry_source(coordinate))


def test_tree_sitter_geometry_walk_handles_deep_valid_ast_without_python_recursion():
    nested = "[" * 2_000 + "0" + "]" * 2_000
    assert analyze_geometry_source(f"const nested = {nested}; export default null;") == []


def test_geometry_depth_counts_nodes_and_dense_shared_dag_is_memoized():
    edges = {index: list(range(index + 1, min(index + 65, 256))) for index in range(256)}

    # Nodes 192..255 form a longest path of exactly 64 modules.
    _assert_max_depth(edges, {192})

    # Adding node 191 makes the longest path 65 modules.
    with pytest.raises(Exception, match="depth exceeds"):
        _assert_max_depth(edges, {191})


@pytest.mark.parametrize(
    ("version", "bump"),
    [
        ((2_147_483_647, 0, 0), "major"),
        ((0, 2_147_483_647, 0), "minor"),
        ((0, 0, 2_147_483_647), "patch"),
    ],
)
def test_geometry_semver_components_enforce_postgresql_integer_bounds(version, bump):
    maximum = 2_147_483_647
    assert _version_tuple(f"{maximum}.{maximum}.{maximum}") == (maximum, maximum, maximum)
    with pytest.raises(Exception, match=str(maximum)):
        _version_tuple(f"{maximum + 1}.0.0")
    with pytest.raises(Exception, match=str(maximum)):
        _bump(version, bump)


def test_publish_cross_field_rules_are_validated_by_the_service():
    draft = {
        "draftId": "draft",
        "repository": "common",
        "package": "part",
        "source": geometry_source(),
    }
    cases = [
        (
            {
                "mode": "publish-only",
                "targetDraftId": "draft",
                "drafts": [draft],
                "currentRoots": [],
            },
            "requires version",
        ),
        (
            {
                "mode": "publish-only",
                "targetDraftId": "draft",
                "drafts": [{**draft, "baseGeometryVersionId": 1, "version": "1.0.0"}],
                "currentRoots": [],
            },
            "uses bump instead of version",
        ),
        (
            {
                "mode": "publish-only",
                "targetDraftId": "missing",
                "drafts": [{**draft, "version": "1.0.0"}],
                "currentRoots": [],
            },
            "targetDraftId must identify",
        ),
        (
            {
                "mode": "publish-only",
                "targetDraftId": "draft",
                "drafts": [{**draft, "version": "1.0.0"}],
                "currentRoots": [
                    {
                        "alias": "root",
                        "geometryVersionId": 1,
                        "draftId": "draft",
                    }
                ],
            },
            "exactly one",
        ),
        (
            {
                "mode": "publish-only",
                "targetDraftId": "draft",
                "drafts": [{**draft, "version": "1.0.0"}],
                "currentRoots": [{"alias": "root", "draftId": "draft"}],
            },
            "publish-only roots",
        ),
        (
            {
                "mode": "publish-and-apply",
                "targetDraftId": "draft",
                "drafts": [{**draft, "version": "1.0.0"}],
                "currentRoots": [{"alias": "root", "draftId": "missing"}],
            },
            "root draftId must identify",
        ),
    ]

    for payload, message in cases:
        request = GeometryPublishPlanRequest.model_validate(payload)
        with pytest.raises(HTTPException) as raised:
            _validate_publish_request(request)
        assert raised.value.status_code == 422
        assert message in raised.value.detail


@pytest.mark.asyncio
async def test_geometry_formats_are_rejected_by_service_entrypoints(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)

    invalid_namespace = await client.put(
        "/auth/geometry-namespace",
        headers=headers,
        json={"namespace": "Bad_Name"},
    )
    assert invalid_namespace.status_code == 422
    await set_namespace(client, owner, "format-owner")

    invalid_repository = await client.post(
        "/geometry/repositories",
        headers=headers,
        json={"slug": "Bad_Name"},
    )
    assert invalid_repository.status_code == 422

    base_draft = {
        "draftId": "draft",
        "repository": "common",
        "package": "part",
        "version": "1.0.0",
        "source": geometry_source(),
    }
    base_request = {
        "mode": "publish-only",
        "targetDraftId": "draft",
        "drafts": [base_draft],
        "currentRoots": [],
    }
    invalid_plan_requests = [
        {**base_request, "drafts": [{**base_draft, "repository": "Bad_Name"}]},
        {**base_request, "drafts": [{**base_draft, "package": "Bad_Name"}]},
        {**base_request, "drafts": [{**base_draft, "version": "01.0.0"}]},
        {
            **base_request,
            "mode": "publish-and-apply",
            "currentRoots": [{"alias": "bad-alias", "draftId": "draft"}],
        },
        {
            **base_request,
            "drafts": [
                {
                    **base_draft,
                    "source": geometry_source("caemble:geometry/format-owner/common/part@latest"),
                }
            ],
        },
    ]
    for payload in invalid_plan_requests:
        response = await client.post(
            "/geometry/publish/plan",
            headers=headers,
            json=payload,
        )
        assert response.status_code == 422, response.text

    invalid_plan_hash = await client.post(
        "/geometry/publish",
        headers=headers,
        json={**base_request, "planHash": "not-a-sha256"},
    )
    assert invalid_plan_hash.status_code == 422


@pytest.mark.asyncio
async def test_snapshot_canonical_rules_are_validated_before_database_access(db_session):
    unsorted_roots = GeometrySnapshot.model_validate(
        {
            "schemaVersion": 1,
            "roots": [
                {
                    "alias": "second",
                    "geometryVersionId": 2,
                    "coordinate": "caemble:geometry/abc/repo/pkg@2.0.0",
                    "moduleHash": "2" * 64,
                },
                {
                    "alias": "first",
                    "geometryVersionId": 1,
                    "coordinate": "caemble:geometry/abc/repo/pkg@1.0.0",
                    "moduleHash": "1" * 64,
                },
            ],
            "modules": [],
        }
    )
    unsorted_imports = GeometrySnapshot.model_validate(
        {
            "schemaVersion": 1,
            "roots": [],
            "modules": [
                {
                    "geometryVersionId": 3,
                    "coordinate": "caemble:geometry/abc/repo/root@1.0.0",
                    "moduleFormatVersion": 1,
                    "cadApiVersion": 5,
                    "description": None,
                    "source": geometry_source(),
                    "sourceHash": "3" * 64,
                    "moduleHash": "4" * 64,
                    "imports": [
                        {
                            "geometryVersionId": 2,
                            "coordinate": "caemble:geometry/abc/repo/pkg@2.0.0",
                            "moduleHash": "2" * 64,
                        },
                        {
                            "geometryVersionId": 1,
                            "coordinate": "caemble:geometry/abc/repo/pkg@1.0.0",
                            "moduleHash": "1" * 64,
                        },
                    ],
                }
            ],
        }
    )

    for snapshot, message in [
        (unsorted_roots, "sorted by alias"),
        (unsorted_imports, "imports must be sorted"),
    ]:
        with pytest.raises(HTTPException) as raised:
            await validate_snapshot(db_session, snapshot, owner_id=None)
        assert raised.value.status_code == 422
        assert message in raised.value.detail


@pytest.mark.asyncio
async def test_geometry_plan_rejects_semver_overflow_and_accepts_integer_boundary(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "semver-user")
    maximum = 2_147_483_647
    payload = {
        "mode": "publish-only",
        "targetDraftId": "boundary",
        "drafts": [{
            "draftId": "boundary",
            "repository": "common",
            "package": "part",
            "version": f"{maximum}.{maximum}.{maximum}",
            "source": geometry_source(label="boundary"),
        }],
        "currentRoots": [],
    }

    boundary = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)
    assert boundary.status_code == 200, boundary.text
    assert boundary.json()["steps"][0]["version"] == f"{maximum}.{maximum}.{maximum}"

    explicit_overflow = await client.post(
        "/geometry/publish/plan",
        headers=auth_headers(owner),
        json={
            **payload,
            "drafts": [{**payload["drafts"][0], "version": f"{maximum + 1}.0.0"}],
        },
    )
    assert explicit_overflow.status_code == 422

    base = await plan_and_publish(
        client,
        owner,
        {
            **payload,
            "targetDraftId": "base",
            "drafts": [{
                **payload["drafts"][0],
                "draftId": "base",
                "version": f"0.0.{maximum}",
            }],
        },
    )
    bump_overflow = await client.post(
        "/geometry/publish/plan",
        headers=auth_headers(owner),
        json={
            **payload,
            "targetDraftId": "next",
            "drafts": [{
                "draftId": "next",
                "baseGeometryVersionId": base["published"][0]["id"],
                "repository": "common",
                "package": "part",
                "bump": "patch",
                "source": geometry_source(label="next"),
            }],
        },
    )
    assert bump_overflow.status_code == 400
    assert str(maximum) in bump_overflow.json()["detail"]


@pytest.mark.asyncio
async def test_publish_resolve_archive_and_v3_experiment_projection(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "geometry-user")
    payload = {
        "mode": "publish-and-apply",
        "targetDraftId": "new-plate",
        "drafts": [
            {
                "draftId": "new-plate",
                "repository": "common",
                "package": "plate",
                "version": "0.1.0",
                "description": "첫 Geometry",
                "source": geometry_source(label="plate"),
            }
        ],
        "currentRoots": [{"alias": "plate", "draftId": "new-plate"}],
    }
    result = await plan_and_publish(client, owner, payload)
    version = result["published"][0]
    assert version["coordinate"] == "caemble:geometry/geometry-user/common/plate@0.1.0"
    assert result["geometrySnapshot"]["roots"][0]["geometryVersionId"] == version["id"]
    assert await db_session.scalar(
        select(func.count()).select_from(GeometryRepository).where(
            GeometryRepository.namespace == "geometry-user"
        )
    ) == 1
    repositories = await client.post(
        "/geometry/repositories/list",
        headers=auth_headers(owner),
        json={"scope": "mine", "limit": None, "sort": ["updated_at", "desc"]},
    )
    assert repositories.status_code == 200
    assert repositories.json()["items"][0]["namespace"] == "geometry-user"
    repository_id = repositories.json()["items"][0]["id"]
    packages = await client.post(
        "/geometry/packages/list",
        headers=auth_headers(owner),
        json={
            "scope": "mine",
            "limit": None,
            "filter": {"repository_id": [repository_id, repository_id]},
            "sort": ["name", "asc"],
        },
    )
    assert packages.status_code == 200
    assert packages.json()["items"][0]["latest_version"] == "0.1.0"
    package_id = packages.json()["items"][0]["id"]
    versions = await client.post(
        "/geometry/versions/list",
        headers=auth_headers(owner),
        json={
            "scope": "mine",
            "limit": None,
            "filter": {"package_id": [package_id, package_id]},
            "sort": [["version_major", "desc"], ["version_minor", "desc"], ["version_patch", "desc"]],
        },
    )
    assert [item["id"] for item in versions.json()["items"]] == [version["id"]]

    resolved = await client.get(
        f'/geometry/versions/{version["id"]}/resolve',
        headers=auth_headers(owner),
    )
    assert resolved.status_code == 200
    assert resolved.json()["modules"] == result["geometrySnapshot"]["modules"]
    assert (await client.post("/geometry/list", headers=auth_headers(owner), json={})).status_code == 404
    assert (await client.post("/geometry/upsert", headers=auth_headers(owner), json=[])).status_code == 404
    assert (
        await client.request("DELETE", "/geometry/", headers=auth_headers(owner), json=[])
    ).status_code == 404

    bundle = {
        **experiment_source_bundle(),
        "formatVersion": 3,
        "geometrySnapshot": result["geometrySnapshot"],
    }
    saved = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Geometry Experiment",
            "description": None,
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert saved.status_code == 200, saved.text
    projection = await db_session.scalar(
        select(ExperimentGeometryRoot).where(
            ExperimentGeometryRoot.experiment_id == saved.json()["id"]
        )
    )
    assert projection.alias == "plate"
    assert projection.geometry_version_id == version["id"]
    module_projection = await db_session.scalar(
        select(ExperimentGeometryModule).where(
            ExperimentGeometryModule.experiment_id == saved.json()["id"]
        )
    )
    assert module_projection.geometry_version_id == version["id"]

    tampered = json.loads(json.dumps(bundle))
    tampered["geometrySnapshot"]["modules"][0]["source"] += "\n"
    rejected = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Tampered",
            "sourceBundle": tampered,
            "bundleHash": bundle_hash(tampered),
        },
    )
    assert rejected.status_code == 400

    invalid_alias = json.loads(json.dumps(bundle))
    invalid_alias["geometrySnapshot"]["roots"][0]["alias"] = "bad-alias"
    invalid_coordinate = json.loads(json.dumps(bundle))
    invalid_coordinate["geometrySnapshot"]["roots"][0]["coordinate"] = "not-a-coordinate"
    invalid_source_hash = json.loads(json.dumps(bundle))
    invalid_source_hash["geometrySnapshot"]["modules"][0]["sourceHash"] = "A" * 64
    invalid_module_hash = json.loads(json.dumps(bundle))
    invalid_module_hash["geometrySnapshot"]["modules"][0]["moduleHash"] = "short"
    for index, invalid_bundle in enumerate(
        [invalid_alias, invalid_coordinate, invalid_source_hash, invalid_module_hash]
    ):
        invalid_format = await client.post(
            "/experiment/save",
            headers=auth_headers(owner),
            json={
                "name": f"Invalid Geometry format {index}",
                "sourceBundle": invalid_bundle,
                "bundleHash": bundle_hash(invalid_bundle),
            },
        )
        assert invalid_format.status_code == 422, invalid_format.text

    archived = await client.post(
        f'/geometry/versions/{version["id"]}/archive',
        headers=auth_headers(owner),
    )
    assert archived.status_code == 200
    assert archived.json()["archivedAt"] is not None
    version_list_request = {
        "scope": "mine",
        "limit": None,
        "filter": {"package_id": [package_id, package_id]},
        "sort": [["version_major", "desc"], ["version_minor", "desc"], ["version_patch", "desc"]],
    }
    active_versions = await client.post(
        "/geometry/versions/list",
        headers=auth_headers(owner),
        json={**version_list_request, "null_filter": {"archived_at": "is_null"}},
    )
    archived_versions = await client.post(
        "/geometry/versions/list",
        headers=auth_headers(owner),
        json=version_list_request,
    )
    assert active_versions.json()["items"] == []
    assert [item["id"] for item in archived_versions.json()["items"]] == [version["id"]]
    still_resolves = await client.get(
        f'/geometry/versions/{version["id"]}/resolve',
        headers=auth_headers(owner),
    )
    assert still_resolves.status_code == 200


@pytest.mark.asyncio
async def test_manager_lists_direct_and_indirect_usage_and_revalidates_delete(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "manager-usage")
    child = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "child",
            "drafts": [{
                "draftId": "child",
                "repository": "common",
                "package": "child",
                "version": "1.0.0",
                "source": geometry_source(label="child"),
            }],
            "currentRoots": [],
        },
    )
    child_version = child["published"][0]
    parent = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-and-apply",
            "targetDraftId": "parent",
            "drafts": [{
                "draftId": "parent",
                "repository": "common",
                "package": "parent",
                "version": "1.0.0",
                "source": geometry_source(child_version["coordinate"], label="parent"),
            }],
            "currentRoots": [{"alias": "assembly", "draftId": "parent"}],
        },
    )
    parent_version = parent["published"][0]
    bundle = {
        **experiment_source_bundle(),
        "formatVersion": 3,
        "geometrySnapshot": parent["geometrySnapshot"],
    }
    saved = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Indirect child reference",
            "description": "Manager search target",
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert saved.status_code == 200, saved.text
    list_request = {
        "scope": "mine",
        "offset": 0,
        "limit": 10,
        "sort": [["name", "asc"], ["id", "desc"]],
    }
    child_experiments = await client.post(
        f'/geometry/versions/{child_version["id"]}/experiments/list',
        headers=auth_headers(owner),
        json={**list_request, "search_text": "Manager search"},
    )
    parent_experiments = await client.post(
        f'/geometry/versions/{parent_version["id"]}/experiments/list',
        headers=auth_headers(owner),
        json=list_request,
    )
    dependents = await client.post(
        f'/geometry/versions/{child_version["id"]}/dependents/list',
        headers=auth_headers(owner),
        json=list_request,
    )
    assert child_experiments.status_code == 200
    assert child_experiments.json()["items"][0]["root_alias"] is None
    assert parent_experiments.json()["items"][0]["root_alias"] == "assembly"
    assert [item["id"] for item in dependents.json()["items"]] == [parent_version["id"]]

    usage = await client.post(
        "/geometry/versions/usage",
        headers=auth_headers(owner),
        json={"versionIds": [child_version["id"], parent_version["id"]]},
    )
    usage_by_id = {item["versionId"]: item for item in usage.json()["items"]}
    assert usage_by_id[child_version["id"]] == {
        "versionId": child_version["id"],
        "dependentVersionIds": [parent_version["id"]],
        "dependentVersionCount": 1,
        "experimentCount": 1,
        "deletable": False,
    }
    blocked = await client.request(
        "DELETE",
        "/geometry/versions/",
        headers=auth_headers(owner),
        json=[child_version["id"]],
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "geometry_in_use"
    assert blocked.json()["detail"]["usage"][0]["experimentCount"] == 1

    experiment = await db_session.get(Experiment, saved.json()["id"])
    await db_session.delete(experiment)
    await db_session.commit()
    deleted_parent = await client.request(
        "DELETE",
        "/geometry/versions/",
        headers=auth_headers(owner),
        json=[parent_version["id"]],
    )
    deleted_child = await client.request(
        "DELETE",
        "/geometry/versions/",
        headers=auth_headers(owner),
        json=[child_version["id"]],
    )
    assert deleted_parent.status_code == 200, deleted_parent.text
    assert deleted_child.status_code == 200, deleted_child.text


@pytest.mark.asyncio
async def test_package_delete_allows_imports_within_the_same_package(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "package-cleanup")
    first = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "first",
            "drafts": [{
                "draftId": "first",
                "repository": "common",
                "package": "history",
                "version": "1.0.0",
                "source": geometry_source(label="first"),
            }],
            "currentRoots": [],
        },
    )
    repository = await db_session.scalar(
        select(GeometryRepository).where(GeometryRepository.namespace == "package-cleanup")
    )
    repository_id = repository.id
    second = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "second",
            "drafts": [{
                "draftId": "second",
                "repositoryId": repository_id,
                "repository": "common",
                "package": "history",
                "version": "2.0.0",
                "source": geometry_source(first["published"][0]["coordinate"], label="second"),
            }],
            "currentRoots": [],
        },
    )
    package_id = second["published"][0]["packageId"]
    deleted = await client.request(
        "DELETE",
        "/geometry/packages/",
        headers=auth_headers(owner),
        json=[package_id],
    )
    assert deleted.status_code == 200, deleted.text
    assert await db_session.get(GeometryPackage, package_id) is None
    assert await db_session.get(GeometryVersion, first["published"][0]["id"]) is None
    assert await db_session.get(GeometryVersion, second["published"][0]["id"]) is None


@pytest.mark.asyncio
async def test_publish_and_apply_generates_unique_patch_ancestors(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "graph-user")
    c = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "c",
            "drafts": [{
                "draftId": "c",
                "repository": "common",
                "package": "c",
                "version": "1.0.0",
                "source": geometry_source(label="c"),
            }],
            "currentRoots": [],
        },
    )
    c_version = c["published"][0]
    b = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "b",
            "drafts": [{
                "draftId": "b",
                "repository": "common",
                "package": "b",
                "version": "2.1.0",
                "source": geometry_source(c_version["coordinate"], label="b"),
            }],
            "currentRoots": [],
        },
    )
    b_version = b["published"][0]
    a = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "a",
            "drafts": [{
                "draftId": "a",
                "repository": "common",
                "package": "a",
                "version": "3.0.0",
                "source": geometry_source(b_version["coordinate"], label="a"),
            }],
            "currentRoots": [],
        },
    )
    a_version = a["published"][0]

    payload = {
        "mode": "publish-and-apply",
        "targetDraftId": "c-next",
        "drafts": [{
            "draftId": "c-next",
            "baseGeometryVersionId": c_version["id"],
            "repository": "common",
            "package": "c",
            "bump": "patch",
            "source": geometry_source(label="c-next"),
        }],
        "currentRoots": [{"alias": "assembly", "geometryVersionId": a_version["id"]}],
    }
    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)
    assert plan.status_code == 200, plan.text
    assert [(step["package"], step["version"], step["generated"]) for step in plan.json()["steps"]] == [
        ("c", "1.0.1", False),
        ("b", "2.1.1", True),
        ("a", "3.0.1", True),
    ]
    result = await client.post(
        "/geometry/publish",
        headers=auth_headers(owner),
        json={**payload, "planHash": plan.json()["planHash"]},
    )
    assert result.status_code == 200, result.text
    assert result.json()["roots"][0]["coordinate"].endswith("/common/a@3.0.1")
    assert await db_session.scalar(select(func.count()).select_from(GeometryImport)) == 4


@pytest.mark.asyncio
async def test_new_draft_import_of_edited_version_is_rewritten_to_the_planned_coordinate(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "overlay-user")
    child = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "child",
            "drafts": [{
                "draftId": "child",
                "repository": "common",
                "package": "child",
                "version": "1.0.0",
                "source": geometry_source(label="child"),
            }],
            "currentRoots": [],
        },
    )
    child_version = child["published"][0]
    payload = {
        "mode": "publish-only",
        "targetDraftId": "parent",
        "drafts": [
            {
                "draftId": "child-next",
                "baseGeometryVersionId": child_version["id"],
                "repository": "common",
                "package": "child",
                "bump": "patch",
                "source": geometry_source(label="child-next"),
            },
            {
                "draftId": "parent",
                "repository": "common",
                "package": "parent",
                "version": "1.0.0",
                "source": geometry_source(child_version["coordinate"], label="parent"),
            },
        ],
        "currentRoots": [],
    }

    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)

    assert plan.status_code == 200, plan.text
    steps = plan.json()["steps"]
    assert [(step["draftId"], step["coordinate"]) for step in steps] == [
        ("child-next", "caemble:geometry/overlay-user/common/child@1.0.1"),
        ("parent", "caemble:geometry/overlay-user/common/parent@1.0.0"),
    ]
    assert steps[1]["imports"] == [{
        "draftId": "child-next",
        "coordinate": "caemble:geometry/overlay-user/common/child@1.0.1",
        "moduleHash": steps[0]["moduleHash"],
    }]
    assert "child@1.0.1" in steps[1]["source"]


@pytest.mark.asyncio
async def test_publish_and_apply_includes_only_root_reachable_local_draft_importers(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "local-importer")
    parent = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "parent-base",
            "drafts": [{
                "draftId": "parent-base",
                "repository": "common",
                "package": "parent",
                "version": "1.0.0",
                "source": geometry_source(label="parent-base"),
            }],
            "currentRoots": [],
        },
    )
    unrelated = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "unrelated-base",
            "drafts": [{
                "draftId": "unrelated-base",
                "repository": "common",
                "package": "unrelated",
                "version": "1.0.0",
                "source": geometry_source(label="unrelated-base"),
            }],
            "currentRoots": [],
        },
    )
    parent_version = parent["published"][0]
    unrelated_version = unrelated["published"][0]
    child_coordinate = "caemble:geometry/local-importer/common/child@0.1.0"
    payload = {
        "mode": "publish-and-apply",
        "targetDraftId": "child",
        "drafts": [
            {
                "draftId": "child",
                "repository": "common",
                "package": "child",
                "version": "0.1.0",
                "source": geometry_source(label="child"),
            },
            {
                "draftId": "parent-next",
                "baseGeometryVersionId": parent_version["id"],
                "repository": "common",
                "package": "parent",
                "bump": "patch",
                "source": geometry_source(child_coordinate, label="parent-next"),
            },
            {
                "draftId": "unrelated-next",
                "baseGeometryVersionId": unrelated_version["id"],
                "repository": "common",
                "package": "unrelated",
                "bump": "patch",
                "source": geometry_source(child_coordinate, label="unrelated-next"),
            },
        ],
        "currentRoots": [{"alias": "assembly", "geometryVersionId": parent_version["id"]}],
    }

    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)

    assert plan.status_code == 200, plan.text
    assert [(step["draftId"], step["coordinate"]) for step in plan.json()["steps"]] == [
        ("child", child_coordinate),
        ("parent-next", "caemble:geometry/local-importer/common/parent@1.0.1"),
    ]
    assert plan.json()["roots"][0]["coordinate"].endswith("/common/parent@1.0.1")
    published = await client.post(
        "/geometry/publish",
        headers=auth_headers(owner),
        json={**payload, "planHash": plan.json()["planHash"]},
    )
    assert published.status_code == 200, published.text
    assert [item["coordinate"] for item in published.json()["published"]] == [
        child_coordinate,
        "caemble:geometry/local-importer/common/parent@1.0.1",
    ]


@pytest.mark.asyncio
async def test_publish_and_apply_allocates_mixed_bumps_across_two_versions_of_one_package(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "multi-version")
    child = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "child-base",
            "drafts": [{
                "draftId": "child-base",
                "repository": "common",
                "package": "child",
                "version": "1.0.0",
                "source": geometry_source(label="child-base"),
            }],
            "currentRoots": [],
        },
    )
    child_version = child["published"][0]

    parent_versions = []
    for draft_id, version in (("parent-v1", "1.0.0"), ("parent-v2", "2.0.0")):
        result = await plan_and_publish(
            client,
            owner,
            {
                "mode": "publish-only",
                "targetDraftId": draft_id,
                "drafts": [{
                    "draftId": draft_id,
                    "repository": "common",
                    "package": "parent",
                    "version": version,
                    "source": geometry_source(child_version["coordinate"], label=draft_id),
                }],
                "currentRoots": [],
            },
        )
        parent_versions.append(result["published"][0])

    payload = {
        "mode": "publish-and-apply",
        "targetDraftId": "collector",
        "drafts": [
            {
                "draftId": "child-next",
                "baseGeometryVersionId": child_version["id"],
                "repository": "common",
                "package": "child",
                "bump": "patch",
                "source": geometry_source(label="child-next"),
            },
            {
                "draftId": "parent-v1-next",
                "baseGeometryVersionId": parent_versions[0]["id"],
                "repository": "common",
                "package": "parent",
                "bump": "minor",
                "source": geometry_source(child_version["coordinate"], label="parent-v1-next"),
            },
            {
                "draftId": "parent-v2-next",
                "baseGeometryVersionId": parent_versions[1]["id"],
                "repository": "common",
                "package": "parent",
                "bump": "patch",
                "source": geometry_source(child_version["coordinate"], label="parent-v2-next"),
            },
            {
                "draftId": "collector",
                "repository": "common",
                "package": "collector",
                "version": "1.0.0",
                "source": geometry_source(
                    parent_versions[0]["coordinate"],
                    parent_versions[1]["coordinate"],
                    label="collector",
                ),
            },
        ],
        "currentRoots": [
            {"alias": "legacy", "geometryVersionId": parent_versions[0]["id"]},
            {"alias": "current", "geometryVersionId": parent_versions[1]["id"]},
        ],
    }

    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)

    assert plan.status_code == 200, plan.text
    steps = plan.json()["steps"]
    assert [(step["draftId"], step["version"]) for step in steps] == [
        ("child-next", "1.0.1"),
        ("parent-v1-next", "2.1.0"),
        ("parent-v2-next", "2.1.1"),
        ("collector", "1.0.0"),
    ]
    child_coordinate = steps[0]["coordinate"]
    assert all(
        step["imports"][0]["coordinate"] == child_coordinate
        and child_coordinate in step["source"]
        for step in steps[1:]
        if step["draftId"].startswith("parent-")
    )
    assert [item["coordinate"] for item in steps[3]["imports"]] == [
        "caemble:geometry/multi-version/common/parent@2.1.0",
        "caemble:geometry/multi-version/common/parent@2.1.1",
    ]
    assert {root["alias"]: root["coordinate"] for root in plan.json()["roots"]} == {
        "current": "caemble:geometry/multi-version/common/parent@2.1.1",
        "legacy": "caemble:geometry/multi-version/common/parent@2.1.0",
    }

    published = await client.post(
        "/geometry/publish",
        headers=auth_headers(owner),
        json={**payload, "planHash": plan.json()["planHash"]},
    )
    assert published.status_code == 200, published.text
    assert [item["version"] for item in published.json()["published"]] == [
        "1.0.1",
        "2.1.0",
        "2.1.1",
        "1.0.0",
    ]


@pytest.mark.asyncio
async def test_publish_plan_ignores_unrelated_invalid_or_colliding_local_drafts(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "focused-user")
    await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "occupied",
            "drafts": [{
                "draftId": "occupied",
                "repository": "common",
                "package": "occupied",
                "version": "1.0.0",
                "source": geometry_source(label="occupied"),
            }],
            "currentRoots": [],
        },
    )
    payload = {
        "mode": "publish-only",
        "targetDraftId": "target",
        "drafts": [
            {
                "draftId": "target",
                "repository": "common",
                "package": "target",
                "version": "1.0.0",
                "source": geometry_source(label="target"),
            },
            {
                "draftId": "unrelated",
                "repository": "common",
                "package": "occupied",
                "version": "1.0.0",
                "source": "not valid TSX",
            },
        ],
        "currentRoots": [],
    }

    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)

    assert plan.status_code == 200, plan.text
    assert [step["draftId"] for step in plan.json()["steps"]] == ["target"]


@pytest.mark.asyncio
async def test_publish_request_rejects_duplicate_root_geometry_targets(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "root-user")
    payload = {
        "mode": "publish-and-apply",
        "targetDraftId": "root",
        "drafts": [{
            "draftId": "root",
            "repository": "common",
            "package": "root",
            "version": "1.0.0",
            "source": geometry_source(label="root"),
        }],
        "currentRoots": [
            {"alias": "first", "draftId": "root"},
            {"alias": "second", "draftId": "root"},
        ],
    }

    response = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)

    assert response.status_code == 422
    assert "unique versions or drafts" in response.text


@pytest.mark.asyncio
async def test_geometry_graph_is_owner_scoped_and_admin_can_inspect(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    admin = await create_user(db_session, "admin")
    await set_namespace(client, owner, "first-owner")
    await set_namespace(client, other, "second-owner")
    published = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "owned",
            "drafts": [{
                "draftId": "owned",
                "repository": "common",
                "package": "owned",
                "version": "1.0.0",
                "source": geometry_source(label="owned"),
            }],
            "currentRoots": [],
        },
    )
    version = published["published"][0]
    hidden = await client.get(
        f'/geometry/versions/{version["id"]}/resolve',
        headers=auth_headers(other),
    )
    visible = await client.get(
        f'/geometry/versions/{version["id"]}/resolve',
        headers=auth_headers(admin),
    )
    assert hidden.status_code == 404
    assert visible.status_code == 200

    cross_owner = await client.post(
        "/geometry/publish/plan",
        headers=auth_headers(other),
        json={
            "mode": "publish-only",
            "targetDraftId": "cross",
            "drafts": [{
                "draftId": "cross",
                "repository": "common",
                "package": "cross",
                "version": "1.0.0",
                "source": geometry_source(version["coordinate"], label="cross"),
            }],
            "currentRoots": [],
        },
    )
    assert cross_owner.status_code == 400
    assert "cannot be resolved" in cross_owner.json()["detail"]


@pytest.mark.asyncio
async def test_deleted_owner_leaves_archived_read_only_geometry_for_admin(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    admin = await create_user(db_session, "admin")
    await set_namespace(client, owner, "retained-owner")
    published = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "retained",
            "drafts": [{
                "draftId": "retained",
                "repository": "common",
                "package": "retained",
                "version": "1.0.0",
                "source": geometry_source(label="retained"),
            }],
            "currentRoots": [],
        },
    )
    version = published["published"][0]
    repository = await db_session.scalar(
        select(GeometryRepository).where(GeometryRepository.namespace == "retained-owner")
    )
    assert repository.namespace == "retained-owner"

    persisted_owner = await db_session.get(User, owner.id)
    await db_session.delete(persisted_owner)
    await db_session.commit()
    await db_session.refresh(repository)
    assert repository.user_id is None
    assert repository.archived_at is not None

    listed = await client.post(
        "/geometry/repositories/list",
        headers=auth_headers(admin),
        json={"scope": "visible", "limit": None, "sort": ["updated_at", "desc"]},
    )
    assert listed.status_code == 200
    retained = next(item for item in listed.json()["items"] if item["id"] == repository.id)
    assert retained["user_id"] is None
    assert retained["namespace"] == "retained-owner"
    assert retained["archived_at"] is not None
    assert (
        await client.get(
            f'/geometry/versions/{version["id"]}/resolve',
            headers=auth_headers(admin),
        )
    ).status_code == 200
    assert (
        await client.get(
            f'/geometry/versions/{version["id"]}/resolve',
            headers=auth_headers(other),
        )
    ).status_code == 404
    reused = await client.put(
        "/auth/geometry-namespace",
        headers=auth_headers(other),
        json={"namespace": "retained-owner"},
    )
    assert reused.status_code == 409
    with pytest.raises(DBAPIError):
        db_session.add(
            GeometryRepository(
                user_id=other.id,
                namespace="retained-owner",
                slug="common",
            )
        )
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_publish_rechecks_plan_and_returns_structured_semver_conflict(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "conflict-user")
    first = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "base",
            "drafts": [{
                "draftId": "base",
                "repository": "common",
                "package": "part",
                "version": "1.0.0",
                "source": geometry_source(label="base"),
            }],
            "currentRoots": [],
        },
    )
    base = first["published"][0]
    stale_payload = {
        "mode": "publish-only",
        "targetDraftId": "stale",
        "drafts": [{
            "draftId": "stale",
            "baseGeometryVersionId": base["id"],
            "repository": "common",
            "package": "part",
            "bump": "patch",
            "source": geometry_source(label="stale"),
        }],
        "currentRoots": [],
    }
    stale_plan = await client.post(
        "/geometry/publish/plan",
        headers=auth_headers(owner),
        json=stale_payload,
    )
    assert stale_plan.status_code == 200
    await plan_and_publish(
        client,
        owner,
        {
            **stale_payload,
            "targetDraftId": "winner",
            "drafts": [{**stale_payload["drafts"][0], "draftId": "winner"}],
        },
    )
    conflict = await client.post(
        "/geometry/publish",
        headers=auth_headers(owner),
        json={**stale_payload, "planHash": stale_plan.json()["planHash"]},
    )
    assert conflict.status_code == 409
    body = conflict.json()
    assert body["code"] == "geometry_version_conflict"
    assert body["draftId"] == "stale"
    assert body["coordinate"] == "caemble:geometry/conflict-user/common/part@1.0.1"
    assert body["suggestedVersion"] == "1.0.2"
    assert body["revisedPlan"]["steps"][0]["version"] == "1.0.2"


@pytest.mark.asyncio
async def test_publish_locks_the_geometry_owner_before_replanning_and_writing(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "publish-lock")
    payload = {
        "mode": "publish-only",
        "targetDraftId": "part",
        "drafts": [{
            "draftId": "part",
            "repository": "common",
            "package": "part",
            "version": "1.0.0",
            "source": geometry_source(label="part"),
        }],
        "currentRoots": [],
    }
    plan = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)
    assert plan.status_code == 200, plan.text
    statements: list[str] = []

    def record_statement(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(db_session.bind.sync_engine, "before_cursor_execute", record_statement)
    try:
        published = await client.post(
            "/geometry/publish",
            headers=auth_headers(owner),
            json={**payload, "planHash": plan.json()["planHash"]},
        )
    finally:
        event.remove(db_session.bind.sync_engine, "before_cursor_execute", record_statement)

    assert published.status_code == 200, published.text
    owner_lock = next(
        index
        for index, statement in enumerate(statements)
        if "FROM users" in statement and "FOR UPDATE" in statement
    )
    first_repository_access = next(
        index for index, statement in enumerate(statements) if "FROM geometry_repositories" in statement
    )
    assert owner_lock < first_repository_access


@pytest.mark.asyncio
async def test_database_rejects_published_geometry_mutation_and_deletion(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "immutable-user")
    published = await plan_and_publish(
        client,
        owner,
        {
            "mode": "publish-only",
            "targetDraftId": "immutable",
            "drafts": [{
                "draftId": "immutable",
                "repository": "common",
                "package": "immutable",
                "version": "1.0.0",
                "source": geometry_source(label="immutable"),
            }],
            "currentRoots": [],
        },
    )
    version_id = published["published"][0]["id"]
    with pytest.raises(DBAPIError, match="content is immutable"):
        await db_session.execute(
            update(GeometryVersion)
            .where(GeometryVersion.id == version_id)
            .values(source="export default null;")
        )
    await db_session.rollback()
    with pytest.raises(DBAPIError, match="cannot be deleted"):
        await db_session.execute(delete(GeometryVersion).where(GeometryVersion.id == version_id))
    await db_session.rollback()
    assert await db_session.get(GeometryVersion, version_id) is not None


@pytest.mark.asyncio
async def test_experiment_v3_cannot_be_downgraded_to_v2(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    v3 = {
        **experiment_source_bundle("v3"),
        "formatVersion": 3,
        "geometrySnapshot": {"schemaVersion": 1, "roots": [], "modules": []},
    }
    created = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "v3", "sourceBundle": v3, "bundleHash": bundle_hash(v3)},
    )
    assert created.status_code == 200
    v2 = experiment_source_bundle("v2")
    downgraded = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "id": created.json()["id"],
            "name": "v2",
            "sourceBundle": v2,
            "bundleHash": bundle_hash(v2),
            "baseBundleHash": created.json()["sourceHash"],
        },
    )
    assert downgraded.status_code == 400
    assert "cannot be downgraded" in downgraded.json()["detail"]


@pytest.mark.asyncio
async def test_experiment_registry_import_requires_v3_and_one_default_binding(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    source = 'import geometries from "@caemble/geometries";\nexport default geometries;'
    v2 = experiment_source_bundle()
    v2["files"]["experiment.tsx"] = source
    rejected_v2 = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "v2", "sourceBundle": v2, "bundleHash": bundle_hash(v2)},
    )
    assert rejected_v2.status_code == 400
    assert "not allowed" in rejected_v2.json()["detail"]

    v3 = {
        **v2,
        "formatVersion": 3,
        "geometrySnapshot": {"schemaVersion": 1, "roots": [], "modules": []},
    }
    accepted_v3 = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "v3", "sourceBundle": v3, "bundleHash": bundle_hash(v3)},
    )
    assert accepted_v3.status_code == 200

    named = json.loads(json.dumps(v3))
    named["files"]["experiment.tsx"] = (
        'import { geometry } from "@caemble/geometries";\nexport default geometry;'
    )
    rejected_named = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "named", "sourceBundle": named, "bundleHash": bundle_hash(named)},
    )
    assert rejected_named.status_code == 400
    assert "one default import" in rejected_named.json()["detail"]


def test_experiment_bundle_v2_and_v3_share_one_exact_wire_contract():
    v2 = experiment_source_bundle()
    parsed_v2 = ExperimentSourceBundle.model_validate(v2)
    assert parsed_v2.formatVersion == 2
    assert parsed_v2.model_dump(mode="json") == v2

    empty_v3 = {
        **v2,
        "formatVersion": 3,
        "geometrySnapshot": {"schemaVersion": 1, "roots": [], "modules": []},
    }
    parsed_v3 = ExperimentSourceBundle.model_validate(empty_v3)
    assert parsed_v3.formatVersion == 3
    assert parsed_v3.model_dump(mode="json") == empty_v3


@pytest.mark.asyncio
async def test_experiment_bundle_version_requires_matching_geometry_snapshot(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)

    v3_without_snapshot = {**experiment_source_bundle(), "formatVersion": 3}
    missing = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "name": "missing snapshot",
            "sourceBundle": v3_without_snapshot,
            "bundleHash": bundle_hash(v3_without_snapshot),
        },
    )
    assert missing.status_code == 422

    v2_with_snapshot = {
        **experiment_source_bundle(),
        "geometrySnapshot": {"schemaVersion": 1, "roots": [], "modules": []},
    }
    unexpected = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "name": "unexpected snapshot",
            "sourceBundle": v2_with_snapshot,
            "bundleHash": bundle_hash(v2_with_snapshot),
        },
    )
    assert unexpected.status_code == 422

    v2_with_null_snapshot = {
        **experiment_source_bundle(),
        "geometrySnapshot": None,
    }
    explicit_null = await client.post(
        "/experiment/save",
        headers=headers,
        json={
            "name": "null snapshot",
            "sourceBundle": v2_with_null_snapshot,
            "bundleHash": bundle_hash(v2_with_null_snapshot),
        },
    )
    assert explicit_null.status_code == 422
