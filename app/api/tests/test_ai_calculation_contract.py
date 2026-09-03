from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from cryptography.fernet import Fernet
from pydantic import ValidationError


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

from ai.models import AGENT_WORKSPACE_SCHEMA_VERSION, RunStart  # noqa: E402
from ai.router import _authorize_calculation_workspace  # noqa: E402
from ai.data_tools import VisibleDataReader  # noqa: E402
from ai.session import AgentSessionState, SessionEnvelopeCodec, SessionEnvelopeError  # noqa: E402
from ai.tools import agent_tool_definitions  # noqa: E402
from ai.workspace import StagedCalculation, WorkspaceEditError, bundle_hash, text_hash  # noqa: E402
from models import ExperimentSourceBundle  # noqa: E402


def calculation_start(context: dict[str, object] | None = None) -> dict[str, object]:
    bundle = ExperimentSourceBundle(files={"experiment.tsx": "export default null"})
    return {
        "type": "run.start",
        "request": {"prompt": "edit", "messages": []},
        "provider": "openai",
        "model": "gpt-5.6-luna",
        "workspace": {
            "schemaVersion": AGENT_WORKSPACE_SCHEMA_VERSION,
            "experimentId": 7,
            "baseHash": text_hash("export default function calculate(record) { return { dtype: 'float64', data: 1 } }"),
            "referenceHash": bundle_hash(bundle),
            "workspaceSession": 3,
            "activeFile": None,
            "document": {
                "kind": "calculation",
                "calculationId": 11,
                "experimentId": 7,
                "name": "Power",
                "description": "Read only metadata",
                "sourceCode": "export default function calculate(record) { return { dtype: 'float64', data: 1 } }",
                "editable": True,
                "context": context or {"measurementId": 5},
                "referenceExperiment": {"kind": "experiment", "sourceBundle": bundle.model_dump(mode="json")},
            },
        },
    }


class AiCalculationContractTests(unittest.TestCase):
    def test_document_union_and_context_limit(self) -> None:
        start = RunStart.model_validate(calculation_start())
        self.assertEqual("none", start.reasoningEffort)
        self.assertEqual("calculation", start.workspace.document.kind)
        self.assertEqual(11, start.workspace.document.calculationId)
        with self.assertRaisesRegex(ValidationError, "32 KiB"):
            RunStart.model_validate(calculation_start({"large": "x" * (33 * 1024)}))

    def test_calculation_staging_requires_observed_hash(self) -> None:
        source = "export default function calculate(record) { return { dtype: 'float64', data: 1 } }"
        workspace = StagedCalculation(
            calculation_id=None,
            experiment_id=7,
            name="",
            description="",
            source_code=source,
            editable=True,
            reference_experiment=ExperimentSourceBundle(files={"experiment.tsx": "export default null"}),
        )
        chunk = workspace.read_source(offset=0, length=20)
        self.assertEqual(text_hash(source), chunk.sha256)
        with self.assertRaisesRegex(WorkspaceEditError, "changed before"):
            workspace.write_source("next", "0" * 64)
        result = workspace.write_source("next", chunk.sha256)
        self.assertEqual(text_hash("next"), result["sourceHash"])
        self.assertTrue(workspace.changed)

    def test_kind_specific_tool_permissions(self) -> None:
        workspace = StagedCalculation(
            calculation_id=11,
            experiment_id=7,
            name="Power",
            description="",
            source_code="source",
            editable=True,
            reference_experiment=ExperimentSourceBundle(files={"experiment.tsx": "source"}),
        )
        names = {tool["name"] for tool in agent_tool_definitions(workspace)}
        self.assertIn("read_calculation_source", names)
        self.assertIn("write_calculation_source", names)
        self.assertIn("read_experiment_file", names)
        self.assertNotIn("write_experiment_file", names)
        self.assertNotIn("delete_experiment_file", names)

    def test_session_is_bound_to_document_and_reference(self) -> None:
        codec = SessionEnvelopeCodec([Fernet.generate_key()])
        state = AgentSessionState(
            user_id="user",
            provider="openai",
            model="model",
            credential_fingerprint="credential",
            credential_version=1,
            schema_version=AGENT_WORKSPACE_SCHEMA_VERSION,
            document_kind="calculation",
            document_id=11,
            active_experiment_id=7,
            workspace_session=3,
            workspace_hash="a" * 64,
            reference_hash="b" * 64,
            permission_fingerprint="permission",
        )
        envelope = codec.seal(state)
        opened = codec.open(
            envelope,
            user_id="user",
            provider="openai",
            model="model",
            credential_fingerprint="credential",
            credential_version=1,
            schema_version=AGENT_WORKSPACE_SCHEMA_VERSION,
            document_kind="calculation",
            document_id=11,
            active_experiment_id=7,
            workspace_session=3,
            workspace_hash="a" * 64,
            reference_hash="b" * 64,
            permission_fingerprint="permission",
        )
        self.assertEqual(11, opened.document_id)
        with self.assertRaises(SessionEnvelopeError):
            codec.open(
                envelope,
                user_id="user",
                provider="openai",
                model="model",
                credential_fingerprint="credential",
                credential_version=1,
                schema_version=AGENT_WORKSPACE_SCHEMA_VERSION,
                document_kind="calculation",
                document_id=12,
                active_experiment_id=7,
                workspace_session=3,
                workspace_hash="a" * 64,
                reference_hash="b" * 64,
                permission_fingerprint="permission",
            )


class _Rows:
    def __init__(self, *, one: dict[str, object] | None = None, all_rows: list[dict[str, object]] | None = None):
        self.one = one
        self.all_rows = all_rows or []

    def mappings(self) -> "_Rows":
        return self

    def one_or_none(self) -> dict[str, object] | None:
        return self.one

    def all(self) -> list[dict[str, object]]:
        return self.all_rows


class _Database:
    def __init__(self, *results: _Rows):
        self.results = list(results)

    async def execute(self, _statement: object) -> _Rows:
        return self.results.pop(0)


class AiCalculationAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_can_edit_another_owners_calculation_workspace(self) -> None:
        payload = calculation_start()
        payload["workspace"]["document"]["calculationId"] = None  # type: ignore[index]
        start = RunStart.model_validate(payload)
        authorized = await _authorize_calculation_workspace(
            _Database(_Rows(one={"id": 7, "user_id": "owner", "demo_experiment_id": None})),  # type: ignore[arg-type]
            SimpleNamespace(id="admin", roles=["admin"]),  # type: ignore[arg-type]
            start,
        )
        self.assertTrue(authorized.workspace.document.editable)

    async def test_demo_viewer_keeps_local_ai_source_editing(self) -> None:
        payload = calculation_start()
        payload["workspace"]["document"]["calculationId"] = None  # type: ignore[index]
        start = RunStart.model_validate(payload)
        authorized = await _authorize_calculation_workspace(
            _Database(_Rows(one={"id": 7, "user_id": "owner", "demo_experiment_id": 7})),  # type: ignore[arg-type]
            SimpleNamespace(id="viewer", roles=["user"]),  # type: ignore[arg-type]
            start,
        )
        self.assertTrue(authorized.workspace.document.editable)

    async def test_foreign_non_demo_workspace_remains_hidden(self) -> None:
        payload = calculation_start()
        payload["workspace"]["document"]["calculationId"] = None  # type: ignore[index]
        start = RunStart.model_validate(payload)
        with self.assertRaisesRegex(WorkspaceEditError, "not visible"):
            await _authorize_calculation_workspace(
                _Database(_Rows(one={"id": 7, "user_id": "owner", "demo_experiment_id": None})),  # type: ignore[arg-type]
                SimpleNamespace(id="viewer", roles=["user"]),  # type: ignore[arg-type]
                start,
            )


class AiCalculationVisibleDataTests(unittest.IsolatedAsyncioTestCase):
    async def test_measurement_detail_exposes_recorded_data_ids_and_schema(self) -> None:
        reader = VisibleDataReader(
            _Database(
                _Rows(
                    one={
                        "id": 5,
                        "experiment_id": 7,
                        "vars": {},
                        "material_parameters": {},
                        "recorded_at": None,
                        "updated_at": None,
                    }
                ),
                _Rows(
                    all_rows=[
                        {
                            "id": 19,
                            "name": "detector.power",
                            "quantity_kind": "Power",
                            "tensor_order": 0,
                            "dtype": "float64",
                            "data_schema": {"axes": []},
                            "file_size": 8,
                        }
                    ]
                ),
            ),  # type: ignore[arg-type]
            "user",
        )
        detail = await reader.detail("measurement", 5)
        self.assertEqual(19, detail["recordedData"][0]["id"])
        self.assertEqual({"axes": []}, detail["recordedData"][0]["data_schema"])

    async def test_visible_calculation_source_is_chunked_without_full_detail(self) -> None:
        source = "export default function calculate(record) { return { dtype: 'float64', data: 1 } }"
        detail_reader = VisibleDataReader(
            _Database(
                _Rows(
                    one={
                        "id": 11,
                        "experiment_id": 7,
                        "name": "Power",
                        "description": None,
                        "source_code": source,
                        "updated_at": None,
                    }
                )
            ),  # type: ignore[arg-type]
            "user",
        )
        detail = await detail_reader.detail("calculation", 11)
        self.assertNotIn("sourceCode", detail)
        self.assertEqual(text_hash(source), detail["sourceSha256"])

        source_reader = VisibleDataReader(
            _Database(_Rows(one={"id": 11, "name": "Power", "source_code": source})),  # type: ignore[arg-type]
            "user",
        )
        chunk = await source_reader.read_source("calculation", 11, None, 7, 12)
        self.assertEqual(source[7:19], chunk["content"])
        self.assertEqual(text_hash(source), chunk["sha256"])


if __name__ == "__main__":
    unittest.main()
