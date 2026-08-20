from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

import ai.workspace as agent_workspace
from ai.cad_reference import CAD_AUTHORING_CORE, CAD_AUTHORING_REFERENCE_HASH
from ai.agent import (
    MAX_AGENT_STEPS,
    MAX_TOOL_CALLS,
    AgentRunner,
    PROMPT_TOOL_VERSION,
    SYSTEM_PROMPT,
)
from ai.models import RunStart, parse_client_message
from ai.provider import ProviderError, ProviderStep, ProviderToolCall, ProviderUsage
from ai.session import AgentSessionState, SessionEnvelopeCodec, credential_fingerprint
from ai.tools import ToolExecution, ToolExecutor
from ai.workspace import StagedExperiment, bundle_hash, text_hash
from models import ExperimentSourceBundle


def source_bundle() -> ExperimentSourceBundle:
    return ExperimentSourceBundle.model_validate(
        {
            "formatVersion": 5,
            "files": {
                "experiment.tsx": "export default () => <Main />",
                "geometry.tsx": "export const Geometry = () => <box />",
                "material.tsx": "export const steel = {}",
                "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return {}\n",
                "tasks/main.tsx": "export const Main = () => <task />",
            },
            "geometrySnapshot": {"schemaVersion": 2, "entryImports": [], "modules": []},
        }
    )


def run_start(bundle: ExperimentSourceBundle | None = None) -> RunStart:
    bundle = bundle or source_bundle()
    return RunStart.model_validate(
        {
            "type": "run.start",
            "request": {"prompt": "현재 코드를 확인해 줘", "messages": []},
            "provider": "openai",
            "model": "gpt-5.6-luna",
            "reasoningEffort": "medium",
            "workspace": {
                "experimentId": 4,
                "document": {
                    "kind": "experiment",
                    "formatVersion": 2,
                    "apiVersion": 8,
                    "sourceBundle": bundle.model_dump(mode="json"),
                },
                "baseHash": bundle_hash(bundle),
                "geometryContextVersion": "geometry-v1",
                "workspaceSession": 2,
                "activeFile": "tasks/main.tsx",
            },
        }
    )


class FakeEmitter:
    def __init__(self):
        self.events = []

    async def emit(self, event_type: str, **payload):
        self.events.append({"type": event_type, **payload})


class FinalProvider:
    def __init__(self):
        self.input_items = None
        self.instructions = None
        self.reasoning_context = None

    async def generate(self, **request):
        self.input_items = request["input_items"]
        self.instructions = request["instructions"]
        self.reasoning_context = request["reasoning_context"]
        await request["on_delta"]("완료")
        return ProviderStep(
            text="검토를 완료했습니다.",
            output_items=[
                {"type": "reasoning", "encrypted_content": "opaque"},
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "검토를 완료했습니다."}],
                },
            ],
            tool_calls=[],
            usage=ProviderUsage(
                input_tokens=30,
                output_tokens=5,
                cached_tokens=10,
                cache_write_tokens=2,
            ),
        )

    async def close(self):
        pass


class NoTools:
    async def execute(self, name, arguments):
        raise AssertionError("No tool call was expected")


class ContextTools(NoTools):
    def __init__(self, current: bool):
        self.current = current
        self.checks = 0

    async def provenance_is_current(self, provenance):
        self.checks += 1
        return self.current


@pytest.mark.asyncio
async def test_agent_runner_includes_active_dependencies_and_seals_replay_session():
    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    provider = FinalProvider()
    emitter = FakeEmitter()
    codec = SessionEnvelopeCodec([Fernet.generate_key()])
    runner = AgentRunner(
        run_id="run-1",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=provider,
        tools=NoTools(),
        session_codec=codec,
        emitter=emitter,
        cancel_event=asyncio.Event(),
    )

    result = await runner.run("sk-test")

    source_context = [
        item
        for item in provider.input_items
        if item.get("type") == "message" and '"untrustedSource":true' in item.get("content", "")
    ]
    assert all(item["role"] == "user" for item in source_context)
    assert any('"path":"tasks/main.tsx"' in item["content"] for item in source_context)
    assert any('"path":"geometry.tsx"' in item["content"] for item in source_context)
    assert any('"path":"material.tsx"' in item["content"] for item in source_context)
    assert provider.instructions == SYSTEM_PROMPT
    assert provider.reasoning_context == "current_turn"
    assert not any(
        '"validation"' in message.get("content", "")
        for message in provider.input_items
    )
    assert result["baseHash"] == workspace.source_hash
    assert result["finalBundle"] is None
    assert result["contextUsage"]["cachedTokens"] == 10
    assert {event["type"] for event in emitter.events} >= {
        "context.updated",
        "message.delta",
    }
    state = codec.open(
        result["sessionContextEnvelope"],
        user_id="user-1",
        provider="openai",
        model="gpt-5.6-luna",
        credential_fingerprint=credential_fingerprint("sk-test"),
        credential_version=2,
        active_experiment_id=4,
        workspace_session=2,
        workspace_hash=workspace.source_hash,
        permission_fingerprint="p" * 64,
        prompt_tool_version=PROMPT_TOOL_VERSION,
    )
    assert any(item.get("type") == "reasoning" for item in state.provider_items)
    assert not any(item.get("role") in {"user", "developer"} for item in state.provider_items)
    assert state.working_memory == {"workspace": workspace.manifest()}

    continued_start = run_start()
    continued_start.sessionContextEnvelope = result["sessionContextEnvelope"]
    continued_provider = FinalProvider()
    continued_runner = AgentRunner(
        run_id="run-2",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=continued_start,
        workspace=StagedExperiment(continued_start.workspace.document.sourceBundle),
        provider=continued_provider,
        tools=ContextTools(True),
        session_codec=codec,
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )
    await continued_runner.run("sk-test")
    assert continued_provider.reasoning_context == "all_turns"


def test_agent_generation_policy_and_execution_limits():
    assert PROMPT_TOOL_VERSION == f"caemble-ai-agent-v4-{CAD_AUTHORING_REFERENCE_HASH[:12]}"
    assert MAX_AGENT_STEPS == 12
    assert MAX_TOOL_CALLS == 24
    assert CAD_AUTHORING_CORE in SYSTEM_PROMPT
    assert "get_cad_authoring_reference" in SYSTEM_PROMPT
    assert "Never compile, evaluate, test, or validate" in SYSTEM_PROMPT
    assert "finish immediately" in SYSTEM_PROMPT
    assert run_start().reasoningEffort == "medium"


@pytest.mark.asyncio
async def test_agent_reads_official_cad_reference_before_staging_geometry(monkeypatch):
    class GeometryProvider:
        def __init__(self):
            self.calls = 0

        async def generate(self, **request):
            self.calls += 1
            if self.calls == 1:
                call = ProviderToolCall(
                    call_id="reference-1",
                    name="get_cad_authoring_reference",
                    arguments={"elements": ["Box"]},
                )
            elif self.calls == 2:
                call = ProviderToolCall(
                    call_id="read-1",
                    name="read_experiment_file",
                    arguments={
                        "path": "geometry.tsx",
                        "offset": 0,
                        "length": 24_000,
                    },
                )
            elif self.calls == 3:
                source = source_bundle().files["geometry.tsx"]
                call = ProviderToolCall(
                    call_id="write-1",
                    name="write_experiment_file",
                    arguments={
                        "path": "geometry.tsx",
                        "content": (
                            "import { Box, type Geometry } from '@caemble/core'\n"
                            "export const Shape: Geometry = () => <Box id=\"shape\" />\n"
                        ),
                        "expectedSha256": text_hash(source),
                    },
                )
            else:
                await request["on_delta"]("완료")
                return ProviderStep(text="Geometry를 수정했습니다.", output_items=[], tool_calls=[])
            return ProviderStep(
                text="",
                output_items=[
                    {
                        "type": "function_call",
                        "call_id": call.call_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                ],
                tool_calls=[call],
            )

    class Db:
        async def rollback(self):
            pass

    class Data:
        db = Db()
        user_id = "user-1"

    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    tools = ToolExecutor(data=Data(), catalog=None, workspace=workspace)

    async def skip_snapshot_refresh():
        pass

    monkeypatch.setattr(tools, "_refresh_geometry_snapshot", skip_snapshot_refresh)
    runner = AgentRunner(
        run_id="run-geometry",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=GeometryProvider(),
        tools=tools,
        session_codec=SessionEnvelopeCodec([Fernet.generate_key()]),
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )

    result = await runner.run("sk-test")

    assert result["stagedRevision"] == 1
    assert result["finalBundle"]["files"]["geometry.tsx"].endswith('<Box id="shape" />\n')


def test_active_file_must_exist_in_bundle():
    value = run_start().model_dump(mode="json")
    value["workspace"]["activeFile"] = "tasks/missing.tsx"
    with pytest.raises(ValueError, match="activeFile"):
        RunStart.model_validate(value)


@pytest.mark.asyncio
async def test_runner_rejects_wrong_initial_hash_and_discards_stale_session_envelope():
    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    provider = FinalProvider()
    runner = AgentRunner(
        run_id="run-1",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=provider,
        tools=NoTools(),
        session_codec=SessionEnvelopeCodec([Fernet.generate_key()]),
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )
    start.workspace.baseHash = "b" * 64
    with pytest.raises(ValueError, match="baseHash"):
        await runner.run("sk-test")

    start.workspace.baseHash = workspace.source_hash
    start.sessionContextEnvelope = "stale-envelope"
    result = await runner.run("sk-test")
    assert result["message"] == "검토를 완료했습니다."


@pytest.mark.asyncio
async def test_runner_discards_replay_on_stale_provenance_and_context_pressure():
    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    codec = SessionEnvelopeCodec([Fernet.generate_key()])
    stale_tools = ContextTools(False)
    start.sessionContextEnvelope = codec.seal(
        AgentSessionState(
            user_id="user-1",
            provider="openai",
            model="gpt-5.6-luna",
            credential_fingerprint=credential_fingerprint("sk-test"),
            credential_version=2,
            active_experiment_id=4,
            workspace_session=2,
            workspace_hash=workspace.source_hash,
            permission_fingerprint="p" * 64,
            prompt_tool_version=PROMPT_TOOL_VERSION,
            provider_items=[{"type": "reasoning", "encrypted_content": "stale-replay"}],
            provenance=[
                {
                    "kind": "database",
                    "resourceType": "experiment",
                    "resourceId": 4,
                    "revision": "old",
                }
            ],
        )
    )
    stale_provider = FinalProvider()
    stale_runner = AgentRunner(
        run_id="run-1",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=stale_provider,
        tools=stale_tools,
        session_codec=codec,
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )

    await stale_runner.run("sk-test")

    assert stale_tools.checks == 1
    assert not any(item.get("encrypted_content") == "stale-replay" for item in stale_provider.input_items)

    pressured_bundle = source_bundle()
    pressured_bundle.files["tasks/main.tsx"] = "x" * 90_000
    pressured_start = run_start(pressured_bundle)
    pressured_workspace = StagedExperiment(pressured_bundle)
    pressured_start.sessionContextEnvelope = codec.seal(
        AgentSessionState(
            user_id="user-1",
            provider="openai",
            model="gpt-5.6-luna",
            credential_fingerprint=credential_fingerprint("sk-test"),
            credential_version=2,
            active_experiment_id=4,
            workspace_session=2,
            workspace_hash=pressured_workspace.source_hash,
            permission_fingerprint="p" * 64,
            prompt_tool_version=PROMPT_TOOL_VERSION,
            provider_items=[{"type": "reasoning", "encrypted_content": "r" * 570_000}],
        )
    )
    pressured_provider = FinalProvider()
    pressured_runner = AgentRunner(
        run_id="run-2",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=pressured_start,
        workspace=pressured_workspace,
        provider=pressured_provider,
        tools=ContextTools(True),
        session_codec=codec,
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )

    await pressured_runner.run("sk-test")

    assert not any(
        isinstance(item.get("encrypted_content"), str)
        and len(item["encrypted_content"]) == 570_000
        for item in pressured_provider.input_items
    )


@pytest.mark.asyncio
async def test_runner_uses_standalone_compaction_for_a_non_native_adapter():
    class StandaloneProvider(FinalProvider):
        capabilities = SimpleNamespace(native_compaction=False, standalone_compaction=True)

        def __init__(self):
            super().__init__()
            self.compact_calls = 0

        async def compact(self, **request):
            self.compact_calls += 1
            assert request["input_items"]
            return [{"type": "compaction", "encrypted_content": "standalone"}]

    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    codec = SessionEnvelopeCodec([Fernet.generate_key()])
    start.sessionContextEnvelope = codec.seal(
        AgentSessionState(
            user_id="user-1",
            provider="openai",
            model="gpt-5.6-luna",
            credential_fingerprint=credential_fingerprint("sk-test"),
            credential_version=2,
            active_experiment_id=4,
            workspace_session=2,
            workspace_hash=workspace.source_hash,
            permission_fingerprint="p" * 64,
            prompt_tool_version=PROMPT_TOOL_VERSION,
            provider_items=[{"type": "reasoning", "encrypted_content": "x" * 170_000}],
        )
    )
    provider = StandaloneProvider()
    runner = AgentRunner(
        run_id="run-1",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=provider,
        tools=ContextTools(True),
        session_codec=codec,
        emitter=FakeEmitter(),
        cancel_event=asyncio.Event(),
    )

    await runner.run("sk-test")

    assert provider.compact_calls == 1
    assert provider.reasoning_context == "all_turns"
    assert any(item.get("type") == "compaction" for item in provider.input_items)


@pytest.mark.asyncio
async def test_runner_fails_closed_when_evidence_changes_during_the_run():
    class EvidenceProvider:
        def __init__(self):
            self.calls = 0

        async def generate(self, **request):
            self.calls += 1
            if self.calls == 1:
                return ProviderStep(
                    text="",
                    output_items=[
                        {
                            "type": "function_call",
                            "call_id": "evidence-1",
                            "name": "get_visible_data",
                            "arguments": '{"resource":"experiment","id":4}',
                        }
                    ],
                    tool_calls=[
                        ProviderToolCall(
                            call_id="evidence-1",
                            name="get_visible_data",
                            arguments={"resource": "experiment", "id": 4},
                        )
                    ],
                )
            await request["on_delta"]("REVOKED SECRET")
            return ProviderStep(text="stale answer", output_items=[], tool_calls=[])

    class RevokedTools:
        async def execute(self, name, arguments):
            return ToolExecution(
                {"id": 4, "name": "private"},
                "Read visible experiment 4",
                [
                    {
                        "kind": "database",
                        "label": "private",
                        "resourceType": "experiment",
                        "resourceId": 4,
                        "revision": "old",
                    }
                ],
            )

        async def provenance_is_current(self, provenance):
            return False

    start = run_start()
    workspace = StagedExperiment(start.workspace.document.sourceBundle)
    emitter = FakeEmitter()
    runner = AgentRunner(
        run_id="run-1",
        user_id="user-1",
        credential_version=2,
        permission_fingerprint="p" * 64,
        start=start,
        workspace=workspace,
        provider=EvidenceProvider(),
        tools=RevokedTools(),
        session_codec=SessionEnvelopeCodec([Fernet.generate_key()]),
        emitter=emitter,
        cancel_event=asyncio.Event(),
    )

    with pytest.raises(ProviderError, match="evidence changed"):
        await runner.run("sk-test")
    assert not any(event["type"] == "message.delta" for event in emitter.events)


def test_client_validation_results_are_not_part_of_the_protocol():
    with pytest.raises(ValueError, match="Unsupported WebSocket message type"):
        parse_client_message({"type": "client_tool.result"})


def test_workspace_geometry_graph_sources_are_bounded(monkeypatch):
    value = run_start().model_dump(mode="json")
    module = {
        "geometryVersionId": 1,
        "coordinate": "caemble:geometry/user/repo/package@1.0.0",
        "moduleFormatVersion": 4,
        "cadApiVersion": 7,
        "description": None,
        "source": "x" * 11,
        "sourceHash": "a" * 64,
        "moduleHash": "b" * 64,
        "imports": [],
    }
    value["workspace"]["document"]["sourceBundle"]["geometrySnapshot"]["modules"] = [module]
    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_MODULE_SOURCE_BYTES", 10)
    with pytest.raises(ValueError, match="module source"):
        RunStart.model_validate(value)

    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_MODULE_SOURCE_BYTES", 20)
    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_GRAPH_SOURCE_BYTES", 10)
    with pytest.raises(ValueError, match="graph source"):
        RunStart.model_validate(value)

    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_GRAPH_SOURCE_BYTES", 20)
    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_SNAPSHOT_BYTES", 100)
    with pytest.raises(ValueError, match="Geometry snapshot exceeds"):
        RunStart.model_validate(value)


def test_workspace_geometry_graph_aggregate_items_are_bounded(monkeypatch):
    value = run_start().model_dump(mode="json")
    module_import = {
        "exportName": "Imported",
        "alias": "Imported",
        "geometryVersionId": 2,
        "coordinate": "caemble:geometry/user/repo/imported@1.0.0",
        "moduleHash": "c" * 64,
    }
    value["workspace"]["document"]["sourceBundle"]["geometrySnapshot"]["modules"] = [
        {
            "geometryVersionId": 1,
            "coordinate": "caemble:geometry/user/repo/package@1.0.0",
            "moduleFormatVersion": 4,
            "cadApiVersion": 7,
            "description": None,
            "source": "export const Geometry = () => null",
            "sourceHash": "a" * 64,
            "moduleHash": "b" * 64,
            "imports": [module_import, {**module_import, "alias": "ImportedAgain"}],
        }
    ]
    monkeypatch.setattr(agent_workspace, "MAX_GEOMETRY_GRAPH_ITEMS", 2)

    with pytest.raises(ValueError, match="too many graph items"):
        RunStart.model_validate(value)
