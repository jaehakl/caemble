import hashlib
import json

import pytest
from sqlalchemy import func, select

from db import (
    Experiment,
    ExperimentGeometryImport,
    ExperimentGeometryModule,
    GeometryImport,
    GeometryPackage,
    GeometryRepository,
    GeometryVersion,
)
from service.geometry.source import analyze_geometry_source, module_hash, source_hash
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle

pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def source(name: str = "Shape", *imports: str, extra_export: str | None = None) -> str:
    lines = ['import { type Geometry } from "@caemble/core"']
    lines.extend(imports)
    lines.append(f"export const {name}: Geometry = () => <box size={{[1, 1, 1]}} />")
    if extra_export:
        lines.append(f"export function {extra_export}() {{ return <sphere radius={{1}} /> }}")
    return "\n".join(lines) + "\n"


async def set_namespace(client, user, namespace: str):
    response = await client.put(
        "/auth/geometry-namespace",
        headers=auth_headers(user),
        json={"namespace": namespace},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def plan_and_publish(client, user, payload: dict) -> dict:
    plan = await client.post("/geometry/publish/plan", headers=auth_headers(user), json=payload)
    assert plan.status_code == 200, plan.text
    response = await client.post(
        "/geometry/publish",
        headers=auth_headers(user),
        json={**payload, "planHash": plan.json()["planHash"]},
    )
    assert response.status_code == 200, response.text
    return {"plan": plan.json(), "result": response.json()}


def publish_payload(*drafts: dict, target: str | None = None) -> dict:
    return {"targetDraftId": target or drafts[-1]["draftId"], "drafts": list(drafts)}


def new_draft(draft_id: str, package: str, geometry_source: str, version: str = "0.1.0") -> dict:
    return {
        "draftId": draft_id,
        "repository": "common",
        "package": package,
        "version": version,
        "source": geometry_source,
    }


def experiment_bundle(geometry_source: str, snapshot: dict) -> dict:
    bundle = experiment_source_bundle("import { Assembly } from './geometry'\nvoid Assembly\n")
    bundle["files"]["geometry.tsx"] = geometry_source
    bundle["files"]["tasks/main.tsx"] = "import { Assembly } from '../geometry'\nvoid Assembly\n"
    bundle["geometrySnapshot"] = snapshot
    return bundle


@pytest.mark.parametrize(
    "invalid",
    [
        'export default () => <box size={[1, 1, 1]} />',
        'export const Shape = <box size={[1, 1, 1]} />',
        'export const helper = 1',
        'import Shape from "caemble:geometry/user/repo/pkg@1.0.0"\nexport { Shape }',
    ],
)
def test_source_contract_rejects_non_named_geometry_exports(invalid):
    with pytest.raises(Exception):
        analyze_geometry_source(invalid)


def test_source_contract_supports_multi_export_alias_and_local_rewrite_boundary():
    value = analyze_geometry_source(
        source(
            "Assembly",
            'import { Part as Renamed, Fixture } from "caemble:geometry/owner/common/part@1.2.3"',
            extra_export="Preview",
        )
    )
    assert value["exports"] == ["Assembly", "Preview"]
    assert [(item["exportName"], item["alias"]) for item in value["imports"]] == [
        ("Fixture", "Fixture"),
        ("Part", "Renamed"),
    ]
    local = source(
        "Assembly",
        'import { Part } from "caemble:geometry/owner/common/part@local"',
    )
    with pytest.raises(Exception):
        analyze_geometry_source(local)
    assert analyze_geometry_source(local, allow_local=True)["imports"][0]["coordinate"].endswith("@local")


def test_source_contract_requires_defaults_for_local_geometry_component_props():
    valid = '''import { type Geometry } from "@caemble/core"
interface PartProps { count: number; enabled?: boolean }
const Helper: Geometry<PartProps> = ({ count = 2, enabled = true, materials }) => enabled ? <box scale={[count, 1, 1]} materials={materials} /> : <></>
export { Helper as Assembly }
'''
    assert analyze_geometry_source(valid)["exports"] == ["Assembly"]
    with pytest.raises(Exception, match="explicit defaults"):
        analyze_geometry_source(valid.replace("count = 2", "count"))
    with pytest.raises(Exception, match="direct object destructuring"):
        analyze_geometry_source(
            valid.replace("{ count = 2, enabled = true, materials }", "props")
        )
    with pytest.raises(Exception, match="direct properties with explicit defaults"):
        analyze_geometry_source(valid.replace("materials }", "materials, ...rest }"))
    with pytest.raises(Exception, match="direct properties with explicit defaults"):
        analyze_geometry_source(
            valid.replace("count = 2", "count: { value } = { value: 2 }")
        )
    with pytest.raises(Exception, match="statically enumerable"):
        analyze_geometry_source(
            '''import { type Geometry } from "@caemble/core"
type ImportedProps = Readonly<Record<string, number>>
export const Assembly: Geometry<ImportedProps> = ({ value = 1 }) => <box scale={[value, 1, 1]} />
'''
        )


def test_geometry_source_rejects_inline_material_construction_imports():
    with pytest.raises(Exception, match="material.tsx"):
        analyze_geometry_source(
            'import { type Geometry, Material as InlineMaterial } from "@caemble/core"\n'
            "void InlineMaterial\n"
            "export const Shape: Geometry = () => <box />\n"
        )


def test_module_hash_uses_named_import_provenance_but_not_database_ids():
    coordinate = "caemble:geometry/hash-owner/common/assembly@1.0.0"
    digest = source_hash(source("Assembly"))
    imported = {
        "exportName": "Part",
        "alias": "Child",
        "coordinate": "caemble:geometry/hash-owner/common/part@1.0.0",
        "moduleHash": "a" * 64,
        "geometryVersionId": 1,
    }
    assert module_hash(coordinate, digest, [imported], cad_api_version=7) == module_hash(
        coordinate,
        digest,
        [{**imported, "geometryVersionId": 999}],
        cad_api_version=7,
    )
    assert module_hash(coordinate, digest, [imported], cad_api_version=7) != module_hash(
        coordinate,
        digest,
        [{**imported, "alias": "Other"}],
        cad_api_version=7,
    )
    canonical_v7 = json.dumps(
        {
            "schemaVersion": 2,
            "moduleFormatVersion": 4,
            "cadApiVersion": 7,
            "coordinate": coordinate,
            "sourceHash": digest,
            "imports": [
                {
                    "exportName": "Part",
                    "alias": "Child",
                    "coordinate": imported["coordinate"],
                    "moduleHash": imported["moduleHash"],
                }
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    assert module_hash(coordinate, digest, [imported], cad_api_version=7) == hashlib.sha256(
        canonical_v7.encode("utf-8")
    ).hexdigest()
    assert module_hash(coordinate, digest, [imported], cad_api_version=8) != module_hash(
        coordinate, digest, [imported], cad_api_version=7
    )


@pytest.mark.asyncio
async def test_namespace_can_change_without_rekeying_existing_repository(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "geometry-old")
    first = await plan_and_publish(client, owner, publish_payload(new_draft("first", "first", source())))
    first_coordinate = first["result"]["published"][0]["coordinate"]
    repository = await db_session.scalar(select(GeometryRepository).where(GeometryRepository.namespace == "geometry-old"))

    await set_namespace(client, owner, "geometry-new")
    old_repo = await plan_and_publish(
        client,
        owner,
        publish_payload(
            {
                **new_draft("old-repo", "second", source("Second")),
                "repositoryId": repository.id,
            }
        ),
    )
    new_repo = await plan_and_publish(client, owner, publish_payload(new_draft("new-repo", "third", source("Third"))))
    assert first_coordinate.startswith("caemble:geometry/geometry-old/")
    assert old_repo["result"]["published"][0]["coordinate"].startswith("caemble:geometry/geometry-old/")
    assert new_repo["result"]["published"][0]["coordinate"].startswith("caemble:geometry/geometry-new/")
    assert (await set_namespace(client, owner, "geometry-old"))["geometry_namespace"] == "geometry-old"


@pytest.mark.asyncio
async def test_namespace_collision_includes_other_users_and_orphan_repositories(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    first = await create_user(db_session)
    second = await create_user(db_session)
    first_headers = auth_headers(first)
    second_headers = auth_headers(second)
    response = await client.put(
        "/auth/geometry-namespace",
        headers=first_headers,
        json={"namespace": "reserved-owner"},
    )
    assert response.status_code == 200
    conflict = await client.put(
        "/auth/geometry-namespace",
        headers=second_headers,
        json={"namespace": "reserved-owner"},
    )
    assert conflict.status_code == 409

    plan = await client.post(
        "/geometry/publish/plan",
        headers=first_headers,
        json=publish_payload(new_draft("shape", "shape", source())),
    )
    assert plan.status_code == 200, plan.text
    published = await client.post(
        "/geometry/publish",
        headers=first_headers,
        json={
            **publish_payload(new_draft("shape", "shape", source())),
            "planHash": plan.json()["planHash"],
        },
    )
    assert published.status_code == 200, published.text
    await db_session.delete(first)
    await db_session.commit()
    orphan_conflict = await client.put(
        "/auth/geometry-namespace",
        headers=second_headers,
        json={"namespace": "reserved-owner"},
    )
    assert orphan_conflict.status_code == 409


@pytest.mark.asyncio
async def test_publish_named_multi_export_and_resolve_snapshot_v2(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "multi-owner")
    published = await plan_and_publish(
        client,
        owner,
        publish_payload(new_draft("multi", "multi", source("Assembly", extra_export="Preview"))),
    )
    step = published["plan"]["steps"][0]
    version = published["result"]["published"][0]
    assert step["exports"] == ["Assembly", "Preview"]
    assert step["sourceHash"] == source_hash(step["source"])
    assert step["moduleHash"] == module_hash(
        step["coordinate"], step["sourceHash"], [], cad_api_version=8
    )
    assert version["moduleFormatVersion"] == 4
    assert version["cadApiVersion"] == 8

    resolved = await client.get(f"/geometry/versions/{version['id']}/resolve", headers=auth_headers(owner))
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["schemaVersion"] == 2
    assert resolved.json()["root"]["exports"] == ["Assembly", "Preview"]
    assert resolved.json()["modules"][0]["moduleFormatVersion"] == 4
    assert resolved.json()["modules"][0]["cadApiVersion"] == 8


@pytest.mark.asyncio
async def test_local_publish_is_source_derived_child_first_and_supports_repeated_target(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "closure-owner")
    child_local = "caemble:geometry/closure-owner/common/child@local"
    parent_source = source(
        "Assembly",
        f'import {{ Part as Left, Preview as Right }} from "{child_local}"',
    )
    payload = publish_payload(
        new_draft("child", "child", source("Part", extra_export="Preview")),
        new_draft("parent", "parent", parent_source),
        target="parent",
    )
    published = await plan_and_publish(client, owner, payload)
    steps = published["plan"]["steps"]
    assert [item["draftId"] for item in steps] == ["child", "parent"]
    assert "@local" not in steps[1]["source"]
    assert [(item["exportName"], item["alias"]) for item in steps[1]["imports"]] == [
        ("Part", "Left"),
        ("Preview", "Right"),
    ]
    parent = await db_session.scalar(select(GeometryVersion).where(GeometryVersion.source == steps[1]["source"]))
    imports = list(
        (await db_session.scalars(select(GeometryImport).where(GeometryImport.importer_geometry_version_id == parent.id))).all()
    )
    assert [(item.export_name, item.alias) for item in sorted(imports, key=lambda item: item.alias)] == [
        ("Part", "Left"),
        ("Preview", "Right"),
    ]


@pytest.mark.asyncio
async def test_publish_rejects_static_missing_unresolved_and_unselected_local(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "invalid-owner")
    invalid_sources = [
        'export const Shape = <box size={[1, 1, 1]} />',
        source("Parent", 'import { Missing } from "caemble:geometry/invalid-owner/common/nope@1.0.0"'),
        source("Parent", 'import { Child } from "caemble:geometry/invalid-owner/common/not-supplied@local"'),
    ]
    for index, invalid_source in enumerate(invalid_sources):
        response = await client.post(
            "/geometry/publish/plan",
            headers=auth_headers(owner),
            json=publish_payload(new_draft(f"bad-{index}", f"bad-{index}", invalid_source)),
        )
        assert response.status_code in {404, 422}, response.text
    assert await db_session.scalar(select(func.count()).select_from(GeometryVersion)) == 0


@pytest.mark.asyncio
async def test_publish_rejects_missing_export_and_local_cycle(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "cycle-owner")
    first_local = "caemble:geometry/cycle-owner/common/first@local"
    second_local = "caemble:geometry/cycle-owner/common/second@local"
    cycle = publish_payload(
        new_draft("first", "first", source("First", f'import {{ Second }} from "{second_local}"')),
        new_draft("second", "second", source("Second", f'import {{ First }} from "{first_local}"')),
        target="first",
    )
    response = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=cycle)
    assert response.status_code == 422, response.text

    child = await plan_and_publish(client, owner, publish_payload(new_draft("child", "child", source("Child"))))
    coordinate = child["result"]["published"][0]["coordinate"]
    missing = publish_payload(new_draft("parent", "parent", source("Parent", f'import {{ Missing }} from "{coordinate}"')))
    response = await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=missing)
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_experiment_save_rebuilds_snapshot_and_projects_direct_and_indirect_usage(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "experiment-owner")
    child_local = "caemble:geometry/experiment-owner/common/child@local"
    published = await plan_and_publish(
        client,
        owner,
        publish_payload(
            new_draft("child", "child", source("Part")),
            new_draft("parent", "parent", source("Assembly", f'import {{ Part }} from "{child_local}"')),
            target="parent",
        ),
    )
    parent = next(item for item in published["result"]["published"] if "/parent@" in item["coordinate"])
    resolved_response = await client.get(f"/geometry/versions/{parent['id']}/resolve", headers=auth_headers(owner))
    assert resolved_response.status_code == 200, resolved_response.text
    resolved = resolved_response.json()
    geometry_source = f'import {{ Assembly }} from "{parent["coordinate"]}"\nexport {{ Assembly }}\n'
    snapshot = {
        "schemaVersion": 2,
        "entryImports": [{
            "exportName": "Assembly",
            "alias": "Assembly",
            "geometryVersionId": parent["id"],
            "coordinate": parent["coordinate"],
            "moduleHash": parent["moduleHash"],
        }],
        "modules": resolved["modules"],
    }
    bundle = experiment_bundle(geometry_source, snapshot)
    saved = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "Geometry experiment", "sourceBundle": bundle, "bundleHash": bundle_hash(bundle)},
    )
    assert saved.status_code == 200, saved.text
    experiment_id = saved.json()["id"]
    assert await db_session.scalar(
        select(func.count()).select_from(ExperimentGeometryImport).where(ExperimentGeometryImport.experiment_id == experiment_id)
    ) == 1
    assert await db_session.scalar(
        select(func.count()).select_from(ExperimentGeometryModule).where(ExperimentGeometryModule.experiment_id == experiment_id)
    ) == 2

    child = next(item for item in published["result"]["published"] if "/child@" in item["coordinate"])
    direct = await client.post(
        f"/geometry/versions/{parent['id']}/experiments/list",
        headers=auth_headers(owner),
        json={"scope": "mine", "limit": 10},
    )
    indirect = await client.post(
        f"/geometry/versions/{child['id']}/experiments/list",
        headers=auth_headers(owner),
        json={"scope": "mine", "limit": 10},
    )
    assert direct.json()["items"][0]["entry_alias"] == "Assembly"
    assert indirect.json()["items"][0]["entry_alias"] is None


@pytest.mark.asyncio
async def test_experiment_save_rejects_snapshot_not_derived_from_geometry_source(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "snapshot-owner")
    published = await plan_and_publish(client, owner, publish_payload(new_draft("shape", "shape", source("Shape"))))
    version = published["result"]["published"][0]
    resolved = (await client.get(f"/geometry/versions/{version['id']}/resolve", headers=auth_headers(owner))).json()
    snapshot = {
        "schemaVersion": 2,
        "entryImports": [{
            "exportName": "Shape",
            "alias": "Shape",
            "geometryVersionId": version["id"],
            "coordinate": version["coordinate"],
            "moduleHash": version["moduleHash"],
        }],
        "modules": resolved["modules"],
    }
    bundle = experiment_bundle("export {}\n", snapshot)
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={"name": "Mismatch", "sourceBundle": bundle, "bundleHash": bundle_hash(bundle)},
    )
    assert response.status_code == 422, response.text
    assert await db_session.scalar(select(func.count()).select_from(Experiment)) == 0


@pytest.mark.asyncio
async def test_experiment_save_reports_geometry_and_relative_import_policy_errors_as_422(
    client, db_session, monkeypatch
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)

    missing_material = experiment_source_bundle()
    missing_material["files"].pop("material.tsx")
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Missing Material source",
            "sourceBundle": missing_material,
            "bundleHash": bundle_hash(missing_material),
        },
    )
    assert response.status_code == 422, response.text

    invalid_geometry = experiment_source_bundle()
    invalid_geometry["files"]["geometry.tsx"] = "export const Shape = <box />\n"
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid Geometry",
            "sourceBundle": invalid_geometry,
            "bundleHash": bundle_hash(invalid_geometry),
        },
    )
    assert response.status_code == 422, response.text

    invalid_relative = experiment_source_bundle()
    invalid_relative["files"]["tasks/main.tsx"] = (
        "import { Assembly } from './geometry'\nvoid Assembly\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid relative import",
            "sourceBundle": invalid_relative,
            "bundleHash": bundle_hash(invalid_relative),
        },
    )
    assert response.status_code == 422, response.text

    invalid_material_relative = experiment_source_bundle()
    invalid_material_relative["files"]["material.tsx"] = (
        "import { Shape } from './geometry'\nvoid Shape\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid material import",
            "sourceBundle": invalid_material_relative,
            "bundleHash": bundle_hash(invalid_material_relative),
        },
    )
    assert response.status_code == 422, response.text

    invalid_material_reexport = experiment_source_bundle()
    invalid_material_reexport["files"]["material.tsx"] = (
        "export { Shape } from './geometry'\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid material re-export",
            "sourceBundle": invalid_material_reexport,
            "bundleHash": bundle_hash(invalid_material_reexport),
        },
    )
    assert response.status_code == 422, response.text

    invalid_inline_material = experiment_source_bundle()
    invalid_inline_material["files"]["experiment.tsx"] = (
        'import { Material as InlineMaterial } from "@caemble/core"\n'
        "void InlineMaterial\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid inline Material",
            "sourceBundle": invalid_inline_material,
            "bundleHash": bundle_hash(invalid_inline_material),
        },
    )
    assert response.status_code == 422, response.text

    invalid_material_namespace = experiment_source_bundle()
    invalid_material_namespace["files"]["material.tsx"] = (
        'import * as core from "@caemble/core"\nvoid core\n'
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid Material namespace import",
            "sourceBundle": invalid_material_namespace,
            "bundleHash": bundle_hash(invalid_material_namespace),
        },
    )
    assert response.status_code == 422, response.text

    invalid_task_material_relative = experiment_source_bundle()
    invalid_task_material_relative["files"]["tasks/main.tsx"] = (
        "import { materials } from './material'\nvoid materials\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Invalid Task material import",
            "sourceBundle": invalid_task_material_relative,
            "bundleHash": bundle_hash(invalid_task_material_relative),
        },
    )
    assert response.status_code == 422, response.text
    assert await db_session.scalar(select(func.count()).select_from(Experiment)) == 0


@pytest.mark.asyncio
async def test_experiment_save_accepts_static_material_imports(
    client, db_session, monkeypatch
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    bundle = experiment_source_bundle(
        'import type { Material } from "@caemble/core"\n'
        "import { Copper } from './material'\n"
        "void (null as Material | null)\nvoid Copper\n"
    )
    bundle["files"]["material.tsx"] = (
        'import { Material } from "@caemble/core"\n'
        "export const Copper = new Material('Copper')\n"
    )
    bundle["files"]["tasks/main.tsx"] = (
        "import { Copper } from '../material'\nvoid Copper\n"
    )
    response = await client.post(
        "/experiment/save",
        headers=auth_headers(owner),
        json={
            "name": "Static Material imports",
            "sourceBundle": bundle,
            "bundleHash": bundle_hash(bundle),
        },
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_repository_counts_restore_and_atomic_safe_delete(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    await set_namespace(client, owner, "repository-owner")

    first_repository = await client.post(
        "/geometry/repositories", headers=headers, json={"slug": "first", "description": "First"}
    )
    second_repository = await client.post(
        "/geometry/repositories", headers=headers, json={"slug": "second", "description": "Second"}
    )
    assert first_repository.status_code == second_repository.status_code == 200
    first_repository_id = first_repository.json()["id"]
    second_repository_id = second_repository.json()["id"]

    base_draft = {
        **new_draft("base", "base", source("Base")),
        "repository": "first",
        "repositoryId": first_repository_id,
    }
    base = await plan_and_publish(client, owner, publish_payload(base_draft))
    base_coordinate = base["result"]["published"][0]["coordinate"]
    dependent_source = source(
        "Dependent",
        f'import {{ Base }} from "{base_coordinate}"',
    )
    dependent_draft = {
        **new_draft("dependent", "dependent", dependent_source),
        "repository": "second",
        "repositoryId": second_repository_id,
    }
    await plan_and_publish(client, owner, publish_payload(dependent_draft))

    listed = await client.post(
        "/geometry/repositories/list",
        headers=headers,
        json={"scope": "mine", "limit": None, "sort": [["slug", "asc"]]},
    )
    assert listed.status_code == 200, listed.text
    by_id = {item["id"]: item for item in listed.json()["items"]}
    assert (by_id[first_repository_id]["package_count"], by_id[first_repository_id]["version_count"]) == (1, 1)
    assert (by_id[second_repository_id]["package_count"], by_id[second_repository_id]["version_count"]) == (1, 1)

    archived = await client.post(f"/geometry/repositories/{first_repository_id}/archive", headers=headers)
    assert archived.status_code == 200
    restored = await client.post(f"/geometry/repositories/{first_repository_id}/restore", headers=headers)
    restored_again = await client.post(f"/geometry/repositories/{first_repository_id}/restore", headers=headers)
    assert restored.status_code == restored_again.status_code == 200
    assert restored_again.json()["archivedAt"] is None

    blocked = await client.delete(f"/geometry/repositories/{first_repository_id}", headers=headers)
    assert blocked.status_code == 409
    assert await db_session.get(GeometryRepository, first_repository_id) is not None

    removed_dependent = await client.delete(f"/geometry/repositories/{second_repository_id}", headers=headers)
    removed_base = await client.delete(f"/geometry/repositories/{first_repository_id}", headers=headers)
    assert removed_dependent.status_code == removed_base.status_code == 200
    assert await db_session.get(GeometryRepository, first_repository_id) is None
    assert await db_session.get(GeometryRepository, second_repository_id) is None


@pytest.mark.asyncio
async def test_manager_lists_search_paginate_and_safe_delete_refreshes_usage(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "manager-owner")
    first = await plan_and_publish(client, owner, publish_payload(new_draft("alpha", "alpha-part", source("Alpha"))))
    second = await plan_and_publish(client, owner, publish_payload(new_draft("beta", "beta-part", source("Beta"))))
    listed = await client.post(
        "/geometry/packages/list",
        headers=auth_headers(owner),
        json={"scope": "mine", "limit": 1, "offset": 0, "search_text": "alpha", "sort": [["name", "asc"], ["id", "asc"]]},
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["name"] == "alpha-part"

    ids = [first["result"]["published"][0]["id"], second["result"]["published"][0]["id"]]
    usage = await client.post(
        "/geometry/versions/usage",
        headers=auth_headers(owner),
        json={"versionIds": ids},
    )
    assert all(item["deletable"] for item in usage.json()["items"])
    deleted = await client.request(
        "DELETE",
        "/geometry/versions/",
        headers=auth_headers(owner),
        json=[ids[0]],
    )
    assert deleted.status_code == 200, deleted.text
    assert await db_session.get(GeometryVersion, ids[0]) is None


@pytest.mark.asyncio
async def test_stale_publish_plan_returns_revised_plan(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    await set_namespace(client, owner, "conflict-owner")
    base = await plan_and_publish(client, owner, publish_payload(new_draft("base", "shape", source("Shape"), "1.0.0")))
    version = base["result"]["published"][0]
    draft = {
        "draftId": "next",
        "baseGeometryVersionId": version["id"],
        "repository": "common",
        "package": "shape",
        "bump": "patch",
        "source": source("Shape") + "\n",
    }
    payload = publish_payload(draft)
    stale = (await client.post("/geometry/publish/plan", headers=auth_headers(owner), json=payload)).json()
    await plan_and_publish(client, owner, publish_payload({**draft, "draftId": "other"}, target="other"))
    response = await client.post(
        "/geometry/publish",
        headers=auth_headers(owner),
        json={**payload, "planHash": stale["planHash"]},
    )
    assert response.status_code == 409, response.text
    assert response.json()["revisedPlan"] is not None
