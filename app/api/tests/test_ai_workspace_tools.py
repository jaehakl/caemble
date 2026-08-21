from __future__ import annotations

import base64
import json
import struct

import pytest

from caemble_catalog import Catalog

import ai.workspace as workspace_module
from ai.cad_reference import CAD_AUTHORING_REFERENCE
from ai.data_tools import VisibleDataError, VisibleDataReader, slice_recorded_tensor
from ai.tools import ToolExecutor, agent_tool_definitions
from ai.workspace import StagedExperiment, WorkspaceEditError, bundle_hash, text_hash
from db import (
    Experiment,
    GeometryPackage,
    GeometryRepository,
    GeometryVersion,
    Material,
    MaterialName,
    MaterialParameter,
    Measurement,
    RecordedData,
)
from models import ExperimentSourceBundle, GeometrySnapshot
from tests.helpers import create_user


def source_bundle(*, task_source: str = "export const Main = () => <task />") -> ExperimentSourceBundle:
    return ExperimentSourceBundle.model_validate(
        {
            "formatVersion": 5,
            "files": {
                "experiment.tsx": "export default () => <Main />",
                "geometry.tsx": "export const Geometry = () => <box />",
                "material.tsx": "export const steel = {}",
                "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return {}\n",
                "tasks/main.tsx": task_source,
            },
            "geometrySnapshot": {"schemaVersion": 2, "entryImports": [], "modules": []},
        }
    )


def test_staged_workspace_hash_guard_revision_delete_and_unvalidated_python_write():
    workspace = StagedExperiment(source_bundle())
    original_hash = workspace.source_hash
    original = workspace.read_file("experiment.tsx", offset=0, length=24_000)

    with pytest.raises(WorkspaceEditError):
        workspace.write_file("experiment.tsx", "changed", "0" * 64)
    result = workspace.write_file(
        "experiment.tsx",
        "export default () => <Main width={2} />",
        original.sha256,
    )
    assert result["stagedRevision"] == 1
    assert workspace.source_hash != original_hash

    workspace.write_file(
        "tasks/second.tsx",
        "export const Second = () => <task />",
        None,
    )
    workspace.delete_task(
        "tasks/second.tsx",
        text_hash("export const Second = () => <task />"),
    )
    with pytest.raises(WorkspaceEditError):
        workspace.delete_task("tasks/main.tsx", text_hash(workspace.bundle.files["tasks/main.tsx"]))

    simulate = workspace.read_file("simulate.py", offset=0, length=24_000)
    workspace.write_file("simulate.py", "import os", simulate.sha256)
    assert workspace.bundle.files["simulate.py"] == "import os"


@pytest.mark.asyncio
async def test_agent_write_tool_requires_a_complete_hash_bound_source_read():
    workspace = StagedExperiment(source_bundle())

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    executor = ToolExecutor(
        data=Data(),
        catalog=None,
        workspace=workspace,
    )
    source = workspace.bundle.files["experiment.tsx"]
    source_hash = text_hash(source)
    rejected = await executor.execute(
        "write_experiment_file",
        {
            "path": "experiment.tsx",
            "content": "export default () => <Changed />",
            "expectedSha256": source_hash,
        },
    )
    assert rejected.output["ok"] is False

    await executor.execute(
        "read_experiment_file",
        {"path": "experiment.tsx", "offset": 0, "length": len(source)},
    )
    written = await executor.execute(
        "write_experiment_file",
        {
            "path": "experiment.tsx",
            "content": "export default () => <Changed />",
            "expectedSha256": source_hash,
        },
    )
    assert written.output["stagedRevision"] == 1


@pytest.mark.asyncio
async def test_agent_reads_bounded_official_cad_authoring_details():
    workspace = StagedExperiment(source_bundle())

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    definitions = {item["name"]: item for item in agent_tool_definitions()}
    schema = definitions["get_cad_authoring_reference"]["parameters"]["properties"]["elements"]
    assert schema["minItems"] == 1
    assert schema["maxItems"] == 14
    assert {"Box", "box", "subtract"} <= set(schema["items"]["enum"])

    executor = ToolExecutor(data=Data(), catalog=None, workspace=workspace)
    execution = await executor.execute(
        "get_cad_authoring_reference",
        {"elements": ["Box", "box", "subtract"]},
    )

    assert execution.output["apiVersion"] == 8
    assert [item["tag"] for item in execution.output["elements"]] == ["box", "subtract"]
    assert execution.output["elements"][0]["properties"]
    assert execution.output["elements"][1]["children"]["count"] == "many"
    assert len(execution.model_output().encode("utf-8")) < 64 * 1024
    assert execution.provenance == []

    all_elements = await executor.execute(
        "get_cad_authoring_reference",
        {
            "elements": [
                item["authoringName"] for item in CAD_AUTHORING_REFERENCE["elements"]
            ]
        },
    )
    assert len(all_elements.output["elements"]) == 14
    assert len(all_elements.model_output().encode("utf-8")) < 64 * 1024

    unsupported = await executor.execute(
        "get_cad_authoring_reference",
        {"elements": ["Cube"]},
    )
    assert unsupported.output["ok"] is False


@pytest.mark.asyncio
async def test_agent_searches_and_reads_official_geometry_and_experiment_catalog_items():
    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    definitions = {item["name"]: item for item in agent_tool_definitions()}
    kinds = definitions["get_catalog_item"]["parameters"]["properties"]["kind"]["enum"]
    assert {"geometry", "experiment"} <= set(kinds)

    with Catalog.open_readonly() as catalog:
        executor = ToolExecutor(data=Data(), catalog=catalog, workspace=StagedExperiment(source_bundle()))
        geometry_search = await executor.execute("search_catalog", {"query": "Basketball", "limit": 10})
        experiment_search = await executor.execute("search_catalog", {"query": "DC Uniform Bar", "limit": 10})
        geometry = await executor.execute(
            "get_catalog_item",
            {"kind": "geometry", "key": "basketball-goal"},
        )
        experiment = await executor.execute(
            "get_catalog_item",
            {"kind": "experiment", "key": "dc-uniform-bar"},
        )

    assert any(item["kind"] == "geometry" for item in geometry_search.output["items"])
    assert any(item["kind"] == "experiment" for item in experiment_search.output["items"])
    assert geometry.output["exportName"] == "BasketballGoal"
    assert experiment.output["sourceBundle"]["formatVersion"] == 5
    assert geometry.provenance[0]["resourceType"] == "geometry"
    assert experiment.provenance[0]["resourceType"] == "experiment"


@pytest.mark.asyncio
async def test_agent_source_read_lease_covers_only_the_chunk_delivered_to_the_model():
    source = "한" * 24_000
    workspace = StagedExperiment(source_bundle(task_source=source))

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    executor = ToolExecutor(
        data=Data(),
        catalog=None,
        workspace=workspace,
    )
    first = await executor.execute(
        "read_experiment_file",
        {"path": "tasks/main.tsx", "offset": 0, "length": len(source)},
    )
    assert first.output["nextOffset"] is not None
    assert json.loads(first.model_output())["ok"] is True

    rejected = await executor.execute(
        "write_experiment_file",
        {
            "path": "tasks/main.tsx",
            "content": "export const Main = () => <task />",
            "expectedSha256": text_hash(source),
        },
    )
    assert rejected.output["ok"] is False


def test_bundle_hash_matches_frontend_cad_source_hash_fixture():
    assert bundle_hash(source_bundle()) == "50bf96de0f339ad8593292bf872b720fad1677610e17b33f4470b54769cc0008"


def test_staged_workspace_reuses_its_hash_until_a_mutation(monkeypatch):
    workspace = StagedExperiment(source_bundle())
    expected = workspace.source_hash

    def unexpected_rehash(_bundle):
        raise AssertionError("source_hash property must not re-hash the bundle")

    monkeypatch.setattr(workspace_module, "bundle_hash", unexpected_rehash)
    assert workspace.source_hash == expected
    assert workspace.changed is False


def test_server_resolved_geometry_snapshot_uses_the_workspace_aggregate_cap(monkeypatch):
    workspace = StagedExperiment(source_bundle())
    snapshot = GeometrySnapshot.model_validate(
        {
            "schemaVersion": 2,
            "entryImports": [],
            "modules": [
                {
                    "geometryVersionId": 1,
                    "coordinate": "caemble:geometry/user/repo/package@1.0.0",
                    "moduleFormatVersion": 4,
                    "cadApiVersion": 7,
                    "description": None,
                    "source": "export const Geometry = () => null",
                    "sourceHash": "a" * 64,
                    "moduleHash": "b" * 64,
                    "imports": [],
                }
            ],
        }
    )
    monkeypatch.setattr(workspace_module, "MAX_GEOMETRY_GRAPH_ITEMS", 0)

    with pytest.raises(WorkspaceEditError, match="too many graph items"):
        workspace.replace_geometry_snapshot(snapshot)


@pytest.mark.asyncio
async def test_visible_search_candidates_receive_revalidatable_provenance():
    workspace = StagedExperiment(source_bundle())

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

        async def search(self, resource, query, limit):
            return [{"id": 4, "name": "Candidate", "updatedAt": "old"}]

    executor = ToolExecutor(
        data=Data(),
        catalog=None,
        workspace=workspace,
    )
    execution = await executor.execute(
        "search_visible_data",
        {"resource": "measurement", "query": "Candidate", "limit": 10},
    )

    assert execution.provenance[0] == {
        "kind": "database-search",
        "label": "measurement search",
        "resourceType": "measurement",
        "resourceId": "Candidate",
        "query": "Candidate",
        "limit": 10,
        "revision": execution.provenance[0]["revision"],
    }
    assert await executor.provenance_is_current(execution.provenance) is True


@pytest.mark.asyncio
async def test_geometry_write_survives_best_effort_snapshot_refresh_failure(monkeypatch):
    workspace = StagedExperiment(source_bundle())

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    executor = ToolExecutor(data=Data(), catalog=None, workspace=workspace)
    source = workspace.bundle.files["geometry.tsx"]
    await executor.execute(
        "read_experiment_file",
        {"path": "geometry.tsx", "offset": 0, "length": len(source)},
    )

    async def failed_refresh():
        raise RuntimeError("catalog unavailable")

    monkeypatch.setattr(executor, "_refresh_geometry_snapshot", failed_refresh)
    execution = await executor.execute(
        "write_experiment_file",
        {
            "path": "geometry.tsx",
            "content": "export const Geometry = () => <broken",
            "expectedSha256": text_hash(source),
        },
    )

    assert execution.output["stagedRevision"] == 1
    assert workspace.bundle.files["geometry.tsx"].endswith("<broken")


def test_recorded_data_slice_bounds_inline_and_base64_without_full_result():
    inline = {
        "tensorEncodingVersion": 1,
        "shape": [2, 3],
        "storage": {"kind": "inline", "value": [[1, 2, 3], [4, 5, 6]]},
    }
    assert slice_recorded_tensor(inline, "int32", 2, 3)["values"] == [3, 4, 5]

    raw = struct.pack("<6d", 1, 2, 3, 4, 5, 6)
    encoded = {
        "tensorEncodingVersion": 1,
        "shape": [6],
        "storage": {
            "kind": "base64",
            "data": base64.b64encode(raw).decode(),
            "byteLength": len(raw),
        },
    }
    sliced = slice_recorded_tensor(encoded, "float64", 3, 2)
    assert sliced["values"] == [4.0, 5.0]
    assert sliced["nextOffset"] == 5


@pytest.mark.slow
@pytest.mark.asyncio
async def test_visible_material_children_are_public_or_owned_only(db_session):
    owner = await create_user(db_session)
    other = await create_user(db_session)
    material = Material(user_id=None, description="Shared base")
    db_session.add(material)
    await db_session.flush()
    db_session.add_all(
        [
            MaterialName(material_id=material.id, user_id=None, name="Public Name"),
            MaterialName(material_id=material.id, user_id=owner.id, name="Owner Name"),
            MaterialName(material_id=material.id, user_id=other.id, name="Other Secret Name"),
            MaterialParameter(
                material_id=material.id,
                user_id=owner.id,
                name="owner.parameter",
                value={"value": 1},
            ),
            MaterialParameter(
                material_id=material.id,
                user_id=other.id,
                name="other.secret.parameter",
                value={"secret": 2},
            ),
        ]
    )
    await db_session.flush()
    reader = VisibleDataReader(db_session, owner.id)

    detail = await reader.detail("material", material.id)
    assert detail["names"] == ["Owner Name", "Public Name"]
    assert [item["name"] for item in detail["parameters"]] == ["owner.parameter"]
    assert await reader.search("material", "Other Secret", 10) == []


@pytest.mark.slow
@pytest.mark.asyncio
async def test_agent_visibility_is_public_plus_own_with_private_measurements_and_geometry(db_session):
    owner = await create_user(db_session)
    other = await create_user(db_session)
    owner.geometry_namespace = "owner"
    other.geometry_namespace = "other"
    await db_session.flush()
    bundle = source_bundle().model_dump(mode="json")
    public_experiment = Experiment(
        user_id=None,
        name="Public Experiment",
        description=None,
        source_bundle=bundle,
        source_hash="a" * 64,
    )
    owned_experiment = Experiment(
        user_id=owner.id,
        name="Owned Experiment",
        description=None,
        source_bundle=bundle,
        source_hash="b" * 64,
    )
    other_experiment = Experiment(
        user_id=other.id,
        name="Other Secret Experiment",
        description=None,
        source_bundle=bundle,
        source_hash="c" * 64,
    )
    db_session.add_all([public_experiment, owned_experiment, other_experiment])
    await db_session.flush()

    material_parameters = {
        "schemaVersion": 2,
        "experiment": {"schemaVersion": 1, "materials": {}},
        "tasks": {},
    }
    owned_measurement = Measurement(
        user_id=owner.id,
        experiment_id=public_experiment.id,
        vars={},
        material_parameters=material_parameters,
    )
    other_measurement = Measurement(
        user_id=other.id,
        experiment_id=public_experiment.id,
        vars={},
        material_parameters=material_parameters,
    )
    db_session.add_all([owned_measurement, other_measurement])
    await db_session.flush()
    owned_recorded = RecordedData(
        user_id=owner.id,
        measurement_id=owned_measurement.id,
        name="owned-values",
        tensor_order=1,
        dtype="float64",
        data={"shape": [1], "storage": {"kind": "inline", "value": [1.0]}},
    )
    other_recorded = RecordedData(
        user_id=other.id,
        measurement_id=other_measurement.id,
        name="other-values",
        tensor_order=1,
        dtype="float64",
        data={"shape": [1], "storage": {"kind": "inline", "value": [2.0]}},
    )
    db_session.add_all([owned_recorded, other_recorded])

    repositories = [
        GeometryRepository(user_id=owner.id, namespace="owner", slug="parts", description=None),
        GeometryRepository(user_id=other.id, namespace="other", slug="parts", description=None),
        GeometryRepository(user_id=None, namespace="public", slug="parts", description=None),
    ]
    db_session.add_all(repositories)
    await db_session.flush()
    packages = [GeometryPackage(repository_id=item.id, name="part") for item in repositories]
    db_session.add_all(packages)
    await db_session.flush()
    versions = [
        GeometryVersion(
            package_id=item.id,
            version_major=1,
            version_minor=0,
            version_patch=0,
            description="Part",
            source="export const Part = () => <box />",
            source_hash=f"{index}" * 64,
            module_hash=f"{index + 3}" * 64,
            module_format_version=4,
            cad_api_version=7,
        )
        for index, item in enumerate(packages)
    ]
    db_session.add_all(versions)
    await db_session.flush()

    reader = VisibleDataReader(db_session, owner.id)
    experiment_ids = {item["id"] for item in await reader.search("experiment", "Experiment", 10)}
    assert experiment_ids == {public_experiment.id, owned_experiment.id}
    assert (await reader.detail("measurement", owned_measurement.id))["id"] == owned_measurement.id
    assert (await reader.read_recorded_slice(owned_recorded.id, 0, 1))["values"] == [1.0]
    assert [item["id"] for item in await reader.search("geometry", "part", 10)] == [versions[0].id]
    for resource, resource_id in (
        ("experiment", other_experiment.id),
        ("measurement", other_measurement.id),
        ("recorded_data", other_recorded.id),
        ("geometry", versions[1].id),
        ("geometry", versions[2].id),
    ):
        with pytest.raises(VisibleDataError):
            await reader.detail(resource, resource_id)
