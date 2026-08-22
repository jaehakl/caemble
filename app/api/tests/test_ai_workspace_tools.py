from __future__ import annotations

import base64
import hashlib
import json
import struct

import pytest
from caemble_catalog import CatalogAmbiguousError

from ai.data_tools import slice_recorded_tensor
from ai.tools import ToolExecutor, agent_tool_definitions
from ai.workspace import StagedExperiment, WorkspaceEditError, bundle_hash, text_hash
from models import ExperimentSourceBundle


def source_bundle(*, include_task: bool = True) -> ExperimentSourceBundle:
    files = {
        "experiment.tsx": "export const Experiment = () => null\n",
        "geometry.tsx": "export const Shape = () => <box />\n",
        "material.tsx": "export {}\n",
        "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return {}\n",
        "shared/math.ts": "export const two = 2\n",
    }
    if include_task:
        files["tasks/main.tsx"] = "export const Main = () => <task />\n"
    return ExperimentSourceBundle(formatVersion=6, files=files)


def test_staged_workspace_uses_bundle_v6_and_allows_taskless_extra_files():
    workspace = StagedExperiment(source_bundle(include_task=False))
    original_hash = workspace.source_hash
    source = workspace.read_file("shared/math.ts", offset=0, length=24_000)
    result = workspace.write_file("shared/math.ts", "export const two = 2.0\n", source.sha256)
    assert result["stagedRevision"] == 1
    assert workspace.source_hash != original_hash
    workspace.write_file("shared/labels.tsx", "export const Label = () => <text />\n", None)
    assert "shared/labels.tsx" in workspace.bundle.files
    with pytest.raises(WorkspaceEditError):
        workspace.write_file("shared/types.d.ts", "export type X = string\n", None)


def test_staged_workspace_deletes_any_non_core_ts_or_tsx_file_but_protects_core_files():
    workspace = StagedExperiment(source_bundle())
    workspace.delete_file("shared/math.ts", text_hash(workspace.bundle.files["shared/math.ts"]))
    workspace.delete_file("tasks/main.tsx", text_hash(workspace.bundle.files["tasks/main.tsx"]))

    assert "shared/math.ts" not in workspace.bundle.files
    assert "tasks/main.tsx" not in workspace.bundle.files
    with pytest.raises(WorkspaceEditError, match="Required Experiment source files"):
        workspace.delete_file("geometry.tsx", text_hash(workspace.bundle.files["geometry.tsx"]))


def test_bundle_hash_matches_canonical_source_bundle_hash():
    bundle = source_bundle()
    canonical = json.dumps(
        bundle.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    assert bundle_hash(bundle) == hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_agent_write_tool_requires_a_complete_hash_bound_source_read():
    workspace = StagedExperiment(source_bundle())

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    executor = ToolExecutor(data=Data(), catalog=None, workspace=workspace)
    source = workspace.bundle.files["experiment.tsx"]
    source_hash = text_hash(source)
    rejected = await executor.execute(
        "write_experiment_file",
        {
            "path": "experiment.tsx",
            "content": "export const Experiment = () => <Changed />\n",
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
            "content": "export const Experiment = () => <Changed />\n",
            "expectedSha256": source_hash,
        },
    )
    assert written.output["stagedRevision"] == 1

    shared_source = workspace.bundle.files["shared/math.ts"]
    shared_hash = text_hash(shared_source)
    rejected_delete = await executor.execute(
        "delete_experiment_file",
        {"path": "shared/math.ts", "expectedSha256": shared_hash},
    )
    assert rejected_delete.output["ok"] is False
    await executor.execute(
        "read_experiment_file",
        {"path": "shared/math.ts", "offset": 0, "length": len(shared_source)},
    )
    deleted = await executor.execute(
        "delete_experiment_file",
        {"path": "shared/math.ts", "expectedSha256": shared_hash},
    )
    assert deleted.output["deleted"] is True
    assert "shared/math.ts" not in workspace.bundle.files


def test_agent_tool_contract_has_no_geometry_database_or_catalog_resource():
    definitions = {item["name"]: item for item in agent_tool_definitions()}
    catalog_kinds = definitions["get_catalog_item"]["parameters"]["properties"]["kind"]["enum"]
    visible = definitions["get_visible_data"]["parameters"]["properties"]["resource"]["enum"]
    sources = definitions["read_visible_source"]["parameters"]["properties"]["resource"]["enum"]
    assert "geometry" not in catalog_kinds
    assert "geometry" not in visible
    assert sources == ["experiment"]
    assert "delete_experiment_file" in definitions
    assert "delete_experiment_task" not in definitions


@pytest.mark.asyncio
async def test_catalog_ambiguity_stays_inside_the_ai_tool_error_boundary():
    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()

    class Catalog:
        def experiment(self, key):
            raise CatalogAmbiguousError(f"Ambiguous Experiment key: {key}")

    result = await ToolExecutor(
        data=Data(), catalog=Catalog(), workspace=StagedExperiment(source_bundle())
    ).execute("get_catalog_item", {"kind": "experiment", "key": "duplicate"})

    assert result.output == {"ok": False, "error": "Ambiguous Experiment key: duplicate"}


def test_recorded_data_slice_bounds_inline_and_base64_without_full_result():
    inline = {"shape": [2, 3], "storage": {"kind": "inline", "value": [[1, 2, 3], [4, 5, 6]]}}
    assert slice_recorded_tensor(inline, "int32", 2, 3)["values"] == [3, 4, 5]
    raw = struct.pack("<6f", *[float(value) for value in range(6)])
    encoded = {
        "shape": [6],
        "storage": {
            "kind": "base64",
            "data": base64.b64encode(raw).decode("ascii"),
            "byteLength": len(raw),
        },
    }
    assert slice_recorded_tensor(encoded, "float32", 3, 2)["values"] == [3.0, 4.0]
