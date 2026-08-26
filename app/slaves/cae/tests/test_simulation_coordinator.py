from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest

from app.errors import CaeError
from app.runtime_kernel.api import InputArtifact, SolverResult
from app.runtime_kernel.coordinator import SimulationApi
from app.runtime_kernel.coordinator.run import CaeRun
from app.runtime_kernel.execution import SolverExecutionTransaction
from app.runtime_kernel.resources import ArtifactHandle, StatePatch
from app.runtime_kernel.transport import RecordPacket, RecordResourceHold


class FakeRun:
    def __init__(self) -> None:
        self.run_id = "coordinator-test"
        self.max_run_seconds = 10
        self.trace: list[dict[str, Any]] = []
        self.progress_values: list[Any] = []
        self.measurement = {
            "experiment": {"scene": {}},
            "materialParameters": {},
            "materialWarnings": [],
        }
        self._task_scenes = {"producer": {}, "consumer": {}}
        self._task_material_parameters = {"producer": {}, "consumer": {}}
        self._task_material_warnings = {"producer": [], "consumer": []}
        self.producer = {"kernel": {"name": "producer", "version": "1.0.0"}}
        self.consumer = {"kernel": {"name": "consumer", "version": "1.0.0"}}
        self._registered_tasks = (
            ("producer", self.producer, {**self.producer, "config": {}}),
            ("consumer", self.consumer, {**self.consumer, "config": {}}),
        )
        self._task_descriptors = {
            "producer": {"inputPorts": {}},
            "consumer": {
                "inputPorts": {
                    "field": {
                        "artifactTypes": ["test/field@1"],
                        "minimumOccurrences": 1,
                        "maximumOccurrences": 1,
                    }
                }
            },
        }
        self._task_abi_versions = {"producer": 1, "consumer": 1}
        self._output_specs = {
            "producer": {
                "field": {
                    "artifactType": "test/field@1",
                    "data": {"dtype": "float64", "axes": [{"name": "x"}]},
                }
            },
            "consumer": {
                "answer": {
                    "artifactType": "test/scalar@1",
                    "data": {"dtype": "float64"},
                }
            },
        }
        self.recorded: tuple[str, Any] | None = None
        self.on_record = None

    async def progress(self, value: Any) -> None:
        self.progress_values.append(value)

    async def record(self, name: str, value: Any, *, resource_hold: Any = None) -> None:
        if self.on_record is not None:
            self.on_record()
        self.recorded = (name, value)
        if resource_hold is not None:
            resource_hold.hand_off()
            resource_hold.release()


@pytest.mark.asyncio
async def test_state_and_artifact_share_resources_and_legacy_syntax(monkeypatch: pytest.MonkeyPatch) -> None:
    shared = np.arange(4, dtype=np.float64)

    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        field = {"value": shared, "axes": [{"ticks": [0, 1, 2, 3]}]}
        return SolverExecutionTransaction(SolverResult(StatePatch().put("field", field), {"field": field}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    result = await sim.run(run.producer)

    handle = result["artifacts"]["field"]
    assert isinstance(handle, ArtifactHandle)
    assert result["state"]["field"]["value"] is sim._artifacts.resolve(handle)["value"]
    assert result["state"].revision == 1
    assert not result["state"]["field"]["value"].flags.writeable
    sim.close()


@pytest.mark.asyncio
async def test_typed_handoff_unchanged_revision_record_lease_and_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Any, Any]] = []

    async def invoke(
        task: dict[str, Any], state: Any, inputs: Any, *args: Any, **kwargs: Any
    ) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        calls.append((state, inputs))
        if task["kernel"]["name"] == "producer":
            result = SolverResult(StatePatch().put("step", 1), {"field": {"value": np.ones(3)}})
            return SolverExecutionTransaction(result)
        assert isinstance(inputs["field"], InputArtifact)
        result = SolverResult(
            artifacts={"answer": {"value": float(np.sum(inputs["field"].value["value"]))}}
        )
        return SolverExecutionTransaction(result)

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    produced = await sim.run(run.producer)
    consumed = await sim.run(
        run.consumer,
        state=produced["state"],
        inputs={"field": produced["artifacts"]["field"]},
    )

    assert consumed["state"] is produced["state"]
    assert calls[1][0]["step"] == 1
    field = produced["artifacts"]["field"]
    run.on_record = lambda: assert_lease_count(sim, field, 2)
    await sim.record("field", field)
    assert run.recorded is not None
    assert run.recorded[0] == "field"
    np.testing.assert_array_equal(run.recorded[1], np.ones(3))
    assert_lease_count(sim, field, 1)
    sim.release(field)
    with pytest.raises(CaeError, match="live artifact"):
        await sim.run(run.consumer, state=produced["state"], inputs={"field": field})
    sim.close()


@pytest.mark.asyncio
async def test_foreign_state_and_invalid_outputs_are_rejected_without_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invalid(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        result = SolverResult(StatePatch().put("uncommitted", np.ones(2)), {"wrong": np.ones(2)})
        return SolverExecutionTransaction(result)

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invalid)
    first = SimulationApi(FakeRun())
    second_run = FakeRun()
    second_run.run_id = "other-run"
    second = SimulationApi(second_run)
    baseline = first._resources.stats()
    with pytest.raises(CaeError, match="incorrect artifacts"):
        await first.run(first._run.producer)
    assert first._resources.stats() == baseline
    with pytest.raises(CaeError, match="another Measurement run"):
        await second.run(second_run.producer, state=first._states.empty)
    first.close()
    second.close()


@pytest.mark.asyncio
async def test_output_payload_must_match_catalog_dtype_and_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invalid(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        return SolverExecutionTransaction(
            SolverResult(artifacts={"field": {"value": np.ones((2, 1), dtype=np.float32)}})
        )

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invalid)
    run = FakeRun()
    sim = SimulationApi(run)
    baseline = sim._resources.stats()

    with pytest.raises(CaeError, match="dtype float64"):
        await sim.run(run.producer)

    assert sim._resources.stats() == baseline
    sim.close()


@pytest.mark.asyncio
async def test_abi2_spatial_field_output_requires_complete_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invalid(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        return SolverExecutionTransaction(
            SolverResult(artifacts={"field": {"value": np.ones(2, dtype=np.float64)}})
        )

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invalid)
    run = FakeRun()
    run._task_abi_versions["producer"] = 2
    run._output_specs["producer"]["field"].update(
        {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }
    )
    sim = SimulationApi(run)

    with pytest.raises(CaeError, match="field metadata is missing"):
        await sim.run(run.producer)

    sim.close()


@pytest.mark.asyncio
async def test_abi2_spatial_field_output_accepts_complete_domain_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    field = {
        "kind": "caemble.structured-field/v1",
        "domainRef": {
            "kind": "caemble.structured-grid/v1",
            "id": "line-grid",
            "referenceLengthUnit": "m",
            "shape": [2],
            "axes": [{"ticks": [0.25, 0.75], "spacing": 0.5}],
        },
        "location": "cell",
        "quantityKind": "TestField",
        "unit": "1",
        "value": np.ones(2, dtype=np.float64),
    }

    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        return SolverExecutionTransaction(SolverResult(artifacts={"field": field}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    run._task_abi_versions["producer"] = 2
    run._output_specs["producer"]["field"].update(
        {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }
    )
    sim = SimulationApi(run)

    produced = await sim.run(run.producer)

    assert produced["artifacts"]["field"].artifact_type == "test/field@1"
    sim.close()


@pytest.mark.asyncio
async def test_abi2_spatial_input_rejects_legacy_tensor_before_solver_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        nonlocal calls
        del args, kwargs
        calls += 1
        return SolverExecutionTransaction(
            SolverResult(artifacts={"field": {"value": np.ones(2, dtype=np.float64)}})
        )

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    run._task_abi_versions["consumer"] = 2
    run._task_descriptors["consumer"]["inputPorts"]["field"].update(
        {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }
    )
    sim = SimulationApi(run)
    produced = await sim.run(run.producer)

    with pytest.raises(CaeError, match="field metadata is missing"):
        await sim.run(
            run.consumer,
            inputs={"field": produced["artifacts"]["field"]},
        )

    assert calls == 1
    sim.close()


@pytest.mark.asyncio
async def test_artifact_publish_failure_rolls_back_state_revision_and_resources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        result = SolverResult(
            StatePatch().put("uncommitted", np.ones(2)),
            {"field": np.ones(2)},
        )
        return SolverExecutionTransaction(result)

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    baseline = sim._resources.stats()
    monkeypatch.setattr(
        sim._artifacts,
        "publish",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("publish failed")),
    )

    with pytest.raises(RuntimeError, match="publish failed"):
        await sim.run(run.producer)

    assert [revision.revision for revision in sim._states.revisions()] == [0]
    assert sim._resources.stats() == baseline
    sim.close()


@pytest.mark.asyncio
async def test_mmap_commit_failure_rolls_back_committed_state_and_artifacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs

        def fail_commit() -> None:
            raise RuntimeError("mmap commit failed")

        return SolverExecutionTransaction(
            SolverResult(StatePatch().put("uncommitted", 1), {"field": np.ones(2)}),
            commit=fail_commit,
        )

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    baseline = sim._resources.stats()

    with pytest.raises(RuntimeError, match="mmap commit failed"):
        await sim.run(run.producer)

    assert [revision.revision for revision in sim._states.revisions()] == [0]
    assert sim._artifacts.handles() == ()
    assert sim._resources.stats() == baseline
    sim.close()


@pytest.mark.asyncio
async def test_record_resource_lease_survives_record_coroutine_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invoke(*args: Any, **kwargs: Any) -> SolverExecutionTransaction[SolverResult]:
        del args, kwargs
        return SolverExecutionTransaction(SolverResult(artifacts={"field": np.ones(2)}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    produced = await sim.run(run.producer)
    handle = produced["artifacts"]["field"]
    started = asyncio.Event()
    hold: RecordResourceHold | None = None

    async def pending_record(
        name: str,
        value: Any,
        *,
        resource_hold: RecordResourceHold,
    ) -> None:
        nonlocal hold
        del name, value
        hold = resource_hold
        resource_hold.hand_off()
        started.set()
        await asyncio.Future()

    run.record = pending_record  # type: ignore[method-assign]
    record_task = asyncio.create_task(sim.record("field", handle))
    await started.wait()
    assert_lease_count(sim, handle, 2)

    record_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await record_task
    assert_lease_count(sim, handle, 2)

    assert hold is not None
    hold.release()
    assert_lease_count(sim, handle, 1)
    sim.close()


@pytest.mark.asyncio
async def test_cae_run_ack_releases_packet_resources_once() -> None:
    releases = 0

    def release() -> None:
        nonlocal releases
        releases += 1

    hold = RecordResourceHold(release)
    hold.hand_off()
    packet = RecordPacket(
        sequence=1,
        name="field",
        value={},
        attachments=[],
        byte_length=0,
        ack=asyncio.get_running_loop().create_future(),
        resource_hold=hold,
    )
    run = object.__new__(CaeRun)
    run.pending = packet
    run._record_packets = {packet.sequence: packet}

    run._acknowledge(packet.sequence)
    run._acknowledge(None)

    assert packet.ack.done()
    assert releases == 1
    assert run.pending is None
    assert run._record_packets == {}


@pytest.mark.asyncio
async def test_cae_run_defers_resource_close_until_active_execution_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CloseSpy:
        closed = False

        def close(self) -> None:
            self.closed = True

    async def active_execution() -> None:
        await asyncio.Future()

    monkeypatch.setattr("app.runtime_kernel.coordinator.run.emit", lambda value: None)
    execution = asyncio.create_task(active_execution())
    watchdog = asyncio.create_task(asyncio.sleep(60))
    simulation = CloseSpy()
    run = object.__new__(CaeRun)
    run.closed = False
    run.first_next_watchdog = watchdog
    run.liveness_task = None
    run.progress_task = None
    run.heartbeat_task = None
    run.active_context = None
    run._record_packets = {}
    run.pending = None
    run.simulation_api = simulation
    run.task = execution
    run.on_cleanup = lambda run_id: None
    run.run_id = "deferred-close-test"
    run.job_id = "job"

    run._close()

    assert not simulation.closed
    execution.cancel()
    with pytest.raises(asyncio.CancelledError):
        await execution
    await asyncio.sleep(0)
    assert simulation.closed


def assert_lease_count(sim: SimulationApi, handle: ArtifactHandle, expected: int) -> None:
    assert sim._resources.lease_count(handle.resource_ref) == expected
