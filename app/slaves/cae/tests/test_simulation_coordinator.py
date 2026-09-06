from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import numpy as np
import pytest

from app.errors import CaeError
from app.runtime_kernel.api import InputArtifact, SolverResult
from app.runtime_kernel.coordinator import SimulationApi
from app.runtime_kernel.coordinator.run import CaeRun
from app.runtime_kernel.coordinator.plan import RunPlan, TaskSpec, detached
from app.runtime_kernel.execution import SolverExecutionTransaction
from app.runtime_kernel.resources import (
    ArtifactHandle,
    Field,
    StatePatch,
    StructuredBundle,
    StructuredGrid,
)
from app.runtime_kernel.transport import RecordPacket, RecordResourceHold


class FakeRun:
    def __init__(self) -> None:
        self.run_id = "coordinator-test"
        self.max_run_seconds = 10
        self.trace: list[dict[str, Any]] = []
        self.progress_values: list[Any] = []
        output_specs = {
            "producer": {"field": {
                "artifactType": "test/field@1",
                "data": {"dtype": "float64", "axes": [{"name": "x"}]},
            }},
            "consumer": {"answer": {
                "artifactType": "test/scalar@1", "data": {"dtype": "float64"},
            }},
        }
        descriptors = {
            "producer": {"inputPorts": {}},
            "consumer": {"inputPorts": {"field": {
                "artifactTypes": ["test/field@1"], "minimumOccurrences": 1, "maximumOccurrences": 1,
            }}},
        }
        specs = {
            name: TaskSpec(
                name=name, task={"kernel": {"name": name, "version": "1.0.0"}, "config": {}},
                descriptor=descriptors[name], locator=f"unused:{name}", abi_version=1,
                output_specs=output_specs[name], scene={}, material_parameters={},
            )
            for name in ("producer", "consumer")
        }
        self.plan = RunPlan(specs, {}, {}, (), {
            "field": {"dtype": "float64", "axes": [{"name": "x"}]},
            "field-series": {
                "field": {"dtype": "float32", "axes": [{"name": "time"}, {"name": "x"}, {"name": "y"}]},
                "time": {"dtype": "float32", "axes": [{"name": "time"}]},
            },
        })
        self.recorded: tuple[str, Any] | None = None
        self.on_record = None

    @property
    def producer(self):
        return self.plan.tasks["producer"]

    @property
    def consumer(self):
        return self.plan.tasks["consumer"]

    def configure_task(self, name, *, outputs=None, inputs=None, abi_version=2):
        spec = self.plan.task_specs[name]
        output_specs = detached(spec.output_specs)
        descriptor = detached(spec.descriptor)
        for key, value in (outputs or {}).items():
            output_specs[key].update(value)
        for key, value in (inputs or {}).items():
            descriptor["inputPorts"][key].update(value)
        specs = dict(self.plan.task_specs)
        specs[name] = replace(spec, abi_version=abi_version, output_specs=output_specs, descriptor=descriptor)
        self.plan = replace(self.plan, task_specs=specs)

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
async def test_record_structured_bundle_materializes_mappings_without_copying_arrays() -> None:
    run = FakeRun()
    sim = SimulationApi(run)
    values = np.arange(12, dtype=np.float32).reshape(2, 2, 3)
    handle = sim._artifacts.publish(
        StructuredBundle(
            "test/field-series@1",
            {
                "field": {"value": values},
                "time": np.array([0.0, 1.0], dtype=np.float32),
            },
        ),
        producer_task="producer",
        solver_name="producer",
        solver_version="1.0.0",
        output_name="field",
        artifact_type="test/field-series@1",
        state_revision=0,
        copy_arrays=False,
    )
    resolved = sim._artifacts.resolve(handle)

    await sim.record("field-series", handle)

    assert run.recorded is not None
    recorded = run.recorded[1]
    assert isinstance(recorded, dict)
    assert isinstance(recorded["field"], dict)
    assert recorded["field"]["value"] is resolved.members["field"]["value"]
    assert recorded["time"] is resolved.members["time"]
    assert not recorded["field"]["value"].flags.writeable
    assert_lease_count(sim, handle, 1)
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
    run.configure_task("producer", outputs={"field": {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }}
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
    run.configure_task("producer", outputs={"field": {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }}
    )
    sim = SimulationApi(run)

    produced = await sim.run(run.producer)

    handle = produced["artifacts"]["field"]
    assert handle.artifact_type == "test/field@1"

    await sim.record("field", handle)

    assert run.recorded is not None
    recorded = run.recorded[1]
    assert isinstance(recorded, dict)
    assert recorded["axes"] == field["domainRef"]["axes"]
    np.testing.assert_array_equal(recorded["value"], field["value"])
    assert_lease_count(sim, handle, 1)
    sim.close()


@pytest.mark.asyncio
async def test_typed_field_record_preserves_structured_grid_axes_without_copying() -> None:
    run = FakeRun()
    sim = SimulationApi(run)
    axes = (
        np.array([0.25, 0.75], dtype=np.float64),
        np.array([1.0, 2.0, 3.0], dtype=np.float64),
    )
    domain_ref = sim._resources.ingest(StructuredGrid((2, 3), axes, "m"), copy_arrays=False)
    values = np.arange(6, dtype=np.float64).reshape(2, 3)
    handle = sim._artifacts.publish(
        Field(domain_ref, "cell", "TestField", "1", values),
        producer_task="producer",
        solver_name="producer",
        solver_version="1.0.0",
        output_name="field",
        artifact_type="test/field@1",
        state_revision=0,
        copy_arrays=False,
    )
    resolved = sim._artifacts.resolve(handle)

    await sim.record("field", handle)

    assert run.recorded is not None
    recorded = run.recorded[1]
    assert isinstance(recorded, dict)
    assert recorded["value"] is resolved.values
    assert len(recorded["axes"]) == 2
    np.testing.assert_array_equal(recorded["axes"][0]["ticks"], axes[0])
    np.testing.assert_array_equal(recorded["axes"][1]["ticks"], axes[1])
    assert_lease_count(sim, handle, 1)
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
    run.configure_task("consumer", inputs={"field": {
            "payloadKind": "field",
            "data": {
                "dtype": "float64",
                "axes": [{"name": "x"}],
                "quantityKind": "TestField",
                "unit": "1",
            },
        }}
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


@pytest.mark.asyncio
async def test_task_plan_owns_immutable_handles_and_detaches_each_invocation(monkeypatch):
    run = FakeRun()
    task = run.producer
    with pytest.raises(TypeError):
        task["kernel"]["name"] = "changed"
    with pytest.raises(TypeError):
        run.plan.task_specs["producer"].output_specs["field"]["artifactType"] = "changed"
    sim = SimulationApi(run)
    with pytest.raises(CaeError, match="registered by this BuiltMeasurement"):
        await sim.run(detached(task))
    with pytest.raises(CaeError, match="registered by this BuiltMeasurement"):
        await sim.run(FakeRun().producer)

    async def invoke(normalized, *args, **kwargs):
        assert normalized["kernel"]["name"] == "producer"
        assert kwargs["task_spec"] is run.plan.task_specs["producer"]
        normalized["kernel"]["name"] = "child-local-change"
        return SolverExecutionTransaction(SolverResult(artifacts={"field": np.ones(2)}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    await sim.run(task)
    await sim.run(task)
    assert task["kernel"]["name"] == "producer"
    sim.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["second-artifact", "ingest", "finalized", "cancelled", "noop"])
async def test_commit_failure_has_one_complete_rollback_path(monkeypatch, failure):
    from app.runtime_kernel.coordinator.commit import commit_result
    from app.runtime_kernel.resources import CyclicResourceError

    run = FakeRun()
    sim = SimulationApi(run)
    spec = replace(run.plan.task_specs["producer"], output_specs={
        name: {"artifactType": "test/field@1", "data": {"dtype": "float64", "axes": [{"name": "x"}]}}
        for name in ("first", "second")
    })
    baseline = sim._resources.stats()
    base = sim._states.empty
    patch = StatePatch().put("uncommitted", np.ones(2))
    expected = RuntimeError
    if failure == "noop":
        patch = StatePatch()
    elif failure == "ingest":
        cyclic = {}
        cyclic["cycle"] = cyclic
        patch = StatePatch().put("cycle", cyclic)
        expected = CyclicResourceError
    rollback_calls = []
    cancellation = asyncio.CancelledError("cancel commit")

    def finalize():
        if failure == "cancelled":
            raise cancellation
        if failure == "noop":
            raise RuntimeError("mmap commit failed with unchanged state")

    transaction = SolverExecutionTransaction(
        SolverResult(patch, {"first": np.ones(2), "second": np.ones(2)}),
        commit=finalize, rollback=lambda: rollback_calls.append("rollback"),
    )
    if failure == "finalized":
        transaction.rollback()
    elif failure == "second-artifact":
        publish = sim._artifacts.publish

        def publish_one(ref, **kwargs):
            if kwargs["output_name"] == "second":
                raise RuntimeError("second publish failed")
            return publish(ref, **kwargs)

        monkeypatch.setattr(sim._artifacts, "publish", publish_one)
    elif failure == "cancelled":
        expected = asyncio.CancelledError
    with pytest.raises(expected) as raised:
        commit_result(transaction, spec, base, resources=sim._resources, states=sim._states, artifacts=sim._artifacts)
    if failure == "cancelled":
        assert raised.value is cancellation
    assert transaction.status == "rolled_back"
    assert rollback_calls == ["rollback"]
    assert sim._artifacts.handles() == ()
    assert [revision.revision for revision in sim._states.revisions()] == [0]
    assert sim._resources.stats() == baseline
    sim.close()


@pytest.mark.asyncio
async def test_release_keep_preserves_noop_revision_and_checkpoint(monkeypatch):
    async def invoke(task, state, *args, **kwargs):
        patch = StatePatch() if state.get("step") else StatePatch().put("step", 1)
        return SolverExecutionTransaction(SolverResult(patch, {"field": np.ones(2)}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    first = await sim.run(run.producer)
    second = await sim.run(run.producer, state=first["state"])
    assert second["state"] is first["state"]
    sim.release([first["state"], first["state"]], keep=second["state"])
    assert second["state"]["step"] == 1
    branch = sim._states.commit(first["state"], StatePatch().put("step", 2))
    sim.release({"old": first["state"], "branch": branch}, keep=[branch])
    assert branch["step"] == 2
    assert not sim._states.is_live(first["state"])
    assert sim._artifacts.is_live(first["artifacts"]["field"])
    with pytest.raises(CaeError, match="released or foreign state"):
        sim.release(first["state"])
    sim.release(branch)
    sim.close()


@pytest.mark.asyncio
async def test_invocation_holds_inputs_and_rejects_busy_state_release_atomically(monkeypatch):
    entered = asyncio.Event()
    resume = asyncio.Event()

    async def invoke(task, state, inputs, *args, **kwargs):
        if task["kernel"]["name"] == "producer":
            return SolverExecutionTransaction(SolverResult(StatePatch().put("step", 1), {"field": np.ones(3)}))
        entered.set()
        await resume.wait()
        assert state["step"] == 1
        assert np.sum(inputs["field"].value) == 3
        return SolverExecutionTransaction(SolverResult(artifacts={"answer": 3.0}))

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    produced = await sim.run(run.producer)
    base, artifact = produced["state"], produced["artifacts"]["field"]
    task = asyncio.create_task(sim.run(run.consumer, state=base, inputs={"field": artifact}))
    await entered.wait()
    assert sim._resources.lease_count(artifact.resource_ref) == 2
    with pytest.raises(CaeError, match="invocation"):
        sim.release([artifact, base])
    assert sim._artifacts.is_live(artifact)
    sim.release(base, keep=base)
    sim.release(artifact)
    assert sim._resources.contains(artifact.resource_ref)
    resume.set()
    result = await task
    assert result["state"] is base
    assert not sim._resources.contains(artifact.resource_ref)
    sim.release(base)
    sim.close()


@pytest.mark.asyncio
async def test_cancelled_invocation_releases_holds_and_keeps_cancellation(monkeypatch):
    entered = asyncio.Event()
    cancellation = asyncio.CancelledError("solver stopped")

    async def invoke(task, *args, **kwargs):
        if task["kernel"]["name"] == "producer":
            return SolverExecutionTransaction(SolverResult(StatePatch().put("step", 1), {"field": np.ones(3)}))
        entered.set()
        raise cancellation

    monkeypatch.setattr("app.runtime_kernel.coordinator.simulation.run_kernel_transaction", invoke)
    run = FakeRun()
    sim = SimulationApi(run)
    produced = await sim.run(run.producer)
    base, artifact = produced["state"], produced["artifacts"]["field"]
    baseline = sim._resources.stats()
    with pytest.raises(asyncio.CancelledError) as raised:
        await sim.run(run.consumer, state=base, inputs={"field": artifact})
    assert raised.value is cancellation
    assert entered.is_set()
    assert sim._resources.stats() == baseline
    assert sim._resources.lease_count(artifact.resource_ref) == 1
    sim.release(base)
    assert sim._artifacts.is_live(artifact)
    sim.close()
