"""Execution inputs and model ownership, using a small non-kNN implementation."""
from __future__ import annotations

from dataclasses import FrozenInstanceError
import threading
from types import SimpleNamespace

import pytest

from predictor.errors import PredictionError
from predictor.runtime import PredictorRuntime
from .model_fixtures import model_case
from .test_prediction import call
from .test_training import authorize


def dispatch(worker, action, cancel=None, **payload):
    return worker.dispatch(action, {"protocolVersion": 3, "requestId": "execution-test",
        "sessionId": worker.session_id, **payload}, cancel)


@pytest.fixture
def pinned_case(model_case, monkeypatch):
    grant = authorize(monkeypatch, model_case.worker, model_case.spec)
    call(model_case.worker, "training.pin", grant=grant)
    return model_case


@pytest.fixture
def trained_case(pinned_case):
    pinned_case.worker.training.train(pinned_case.spec, lambda: pinned_case.spec["dataset"])
    return pinned_case


def test_training_load_and_inference_receive_allocated_context(pinned_case):
    case, cancelled, updates = pinned_case, threading.Event(), []
    worker = case.worker
    worker.training.train(case.spec, lambda: case.spec["dataset"], cancelled, updates.append)
    loaded = dispatch(worker, "model.load", cancelled, modelId="trained", revision=1)
    query = {"direction": "forward", "vars": {"x": .5}}
    single = dispatch(worker, "model.predict", cancelled, instance=loaded["instance"], input=query)
    batch = dispatch(worker, "model.predict_batch", cancelled, instance=loaded["instance"],
        inputs=[{"candidateId": str(index), "input": query} for index in range(2)])
    assert [stage for stage, _ in case.contexts] == ["prepare", "load", "predict", "predict", "predict"]
    for _, context in case.contexts:
        assert context.allocation == case.allocation
        assert context.allocation.cpu_ids == [2, 4]
        assert context.allocation.vram_budget_bytes == {"fixture-gpu": 128 * 1024**2}
        assert context.cancel is cancelled
        assert 0 < context.available_ram_bytes <= worker.memory_budget
    with pytest.raises(FrozenInstanceError):
        case.contexts[0][1].available_ram_bytes = 0
    assert {"stage": "training", "fraction": .5, "metrics": {"loss": 1.0}} in updates
    assert all(item["output"] == single["output"] for item in batch["predictions"])
    saved = (worker.store.path("models", "trained", 1) / "model.json").read_text(encoding="utf-8")
    assert "fixture-gpu" not in saved and "available_ram_bytes" not in saved
    assert case.instances[0].close_calls == 1
    call(worker, "model.release", instance=loaded["instance"])


def test_launcher_context_preserves_all_resource_allocation_fields(tmp_path, monkeypatch, model_case):
    monkeypatch.setenv("CAEMBLE_PREDICTOR_OWNER_ID", "owner-1")
    monkeypatch.setenv("CAEMBLE_PREDICTOR_API_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("CAEMBLE_PREDICTOR_STORAGE_ROOT", str(tmp_path / "managed"))
    context = SimpleNamespace(execution=SimpleNamespace(allocation=model_case.allocation,
        identity=SimpleNamespace(launcher_id="launcher-1")))
    worker = PredictorRuntime.from_context(context)
    assert worker._model_context().allocation.model_dump() == model_case.allocation.model_dump()


def test_additional_ram_is_recomputed_for_resident_models_and_release(trained_case, monkeypatch):
    case, worker = trained_case, trained_case.worker
    monkeypatch.setattr("predictor.runtime.psutil.virtual_memory", lambda: SimpleNamespace(available=1024**3))
    first = call(worker, "model.load", modelId="trained", revision=1)
    second = call(worker, "model.load", modelId="trained", revision=1)
    loads = [context for stage, context in case.contexts if stage == "load"]
    assert [context.available_ram_bytes for context in loads] == [worker.memory_budget, worker.memory_budget - 8]
    query = {"direction": "forward", "vars": {"x": .5}}
    call(worker, "model.predict", instance=first["instance"], input=query)
    assert case.contexts[-1][1].available_ram_bytes == worker.memory_budget - 16
    call(worker, "model.release", instance=first["instance"])
    call(worker, "model.predict", instance=second["instance"], input=query)
    assert case.contexts[-1][1].available_ram_bytes == worker.memory_budget - 8
    call(worker, "model.release", instance=second["instance"])
    assert worker._model_context().available_ram_bytes == worker.memory_budget


def test_inference_retained_memory_growth_reduces_the_next_call_budget(trained_case, monkeypatch):
    case, worker = trained_case, trained_case.worker
    monkeypatch.setattr("predictor.runtime.psutil.virtual_memory", lambda: SimpleNamespace(available=1024**3))
    loaded = call(worker, "model.load", modelId="trained", revision=1)
    model = case.instances[-1]
    predict = model.predict
    def predict_and_retain(values, context):
        result = predict(values, context)
        model.persistent_bytes = 32
        return result
    monkeypatch.setattr(model, "predict", predict_and_retain)
    query = {"direction": "forward", "vars": {"x": .5}}
    call(worker, "model.predict", instance=loaded["instance"], input=query)
    call(worker, "model.predict", instance=loaded["instance"], input=query)
    contexts = [context for stage, context in case.contexts if stage == "predict"]
    assert [context.available_ram_bytes for context in contexts] == [worker.memory_budget - 8, worker.memory_budget - 32]
    call(worker, "model.release", instance=loaded["instance"])


def test_batch_cancellation_stops_before_next_candidate_without_releasing_model(trained_case, monkeypatch):
    case, worker, cancelled = trained_case, trained_case.worker, threading.Event()
    loaded = call(worker, "model.load", modelId="trained", revision=1)
    model = case.instances[-1]
    predict = model.predict
    def cancel_after_prediction(values, context):
        result = predict(values, context)
        cancelled.set()
        return result
    monkeypatch.setattr(model, "predict", cancel_after_prediction)
    query = {"direction": "forward", "vars": {"x": .5}}
    with pytest.raises(PredictionError) as stopped:
        dispatch(worker, "model.predict_batch", cancelled, instance=loaded["instance"],
            inputs=[{"candidateId": str(index), "input": query} for index in range(3)])
    assert stopped.value.code == "cancelled"
    assert len([context for stage, context in case.contexts if stage == "predict"]) == 1
    assert model.close_calls == 0
    assert loaded["instance"]["handle"] in worker.instances
    cancelled.clear()
    monkeypatch.setattr(model, "predict", predict)
    assert dispatch(worker, "model.predict", cancelled, instance=loaded["instance"], input=query)["output"][0]["values"] == [42]
    call(worker, "model.release", instance=loaded["instance"])


@pytest.mark.parametrize("failure", ["write", "cancel"])
def test_training_closes_model_after_save_failure_or_cancellation(pinned_case, monkeypatch, failure):
    case, worker, cancelled = pinned_case, pinned_case.worker, threading.Event()
    if failure == "write":
        def fail_write(self, path, cancel=None):
            raise OSError("fixture write failed")
        monkeypatch.setattr(case.implementation, "write", fail_write)

    def progress(stage):
        if failure == "cancel" and stage == "saving":
            cancelled.set()

    with pytest.raises(OSError if failure == "write" else PredictionError):
        worker.training.train(case.spec, lambda: case.spec["dataset"], cancelled, progress)
    assert case.instances[0].close_calls == 1
    assert worker.instances == {}
    assert worker.store.list("models") == []
    assert worker.store.receipt(case.spec["operationId"])["state"] == ("interrupted" if failure == "write" else "cancelled")
    assert list((worker.store.path("datasets", "dataset-1") / "training-pins").glob("*.json"))


@pytest.mark.parametrize("failure", ["checksum", "cancel", "prepared", "lease"])
def test_loaded_model_is_closed_when_handle_installation_fails(trained_case, monkeypatch, failure):
    case, worker, cancelled = trained_case, trained_case.worker, threading.Event()
    request = {"modelId": "trained", "revision": 1}
    if failure == "checksum":
        request["manifestChecksum"] = "0" * 64
    elif failure == "cancel":
        original_load = case.implementation.load
        def cancel_after_load(cls, metadata, content, path, files, context):
            model = original_load(metadata, content, path, files, context)
            cancelled.set()
            return model
        monkeypatch.setattr(case.implementation, "load", classmethod(cancel_after_load))
    elif failure == "prepared":
        def fail_prepared(self):
            raise RuntimeError("fixture preparation details failed")
        monkeypatch.setattr(case.implementation, "preparation_details", fail_prepared)
    else:
        original_lease = worker.store.lease
        def fail_after_lease(identity, revision, handle):
            original_lease(identity, revision, handle)
            raise OSError("fixture lease failed")
        monkeypatch.setattr(worker.store, "lease", fail_after_lease)

    with pytest.raises((PredictionError, RuntimeError, OSError)):
        dispatch(worker, "model.load", cancelled, **request)
    assert case.instances[-1].close_calls == 1
    assert worker.instances == {}
    assert list(worker.store.path("leases", "trained", 1).glob("*.json")) == []


def test_release_closes_before_lease_removal_and_is_idempotent(trained_case, monkeypatch):
    case, worker = trained_case, trained_case.worker
    loaded = call(worker, "model.load", modelId="trained", revision=1)
    model = case.instances[-1]
    release_lease = worker.store.release_lease
    def release_after_close(identity, revision, handle):
        assert model.close_calls == 1 and model.persistent_bytes == 0
        release_lease(identity, revision, handle)
    monkeypatch.setattr(worker.store, "release_lease", release_after_close)
    for _ in range(2):
        assert call(worker, "model.release", instance=loaded["instance"])["released"] is True
    assert model.close_calls == 1
    assert worker.instances == {}


def test_failed_close_keeps_lease_and_memory_until_retry_without_allowing_prediction(trained_case):
    case, worker = trained_case, trained_case.worker
    loaded = call(worker, "model.load", modelId="trained", revision=1)
    instance = loaded["instance"]
    bundle, model = worker.instances[instance["handle"]][1], case.instances[-1]
    model.close_error = RuntimeError("fixture cleanup failed")
    with pytest.raises(RuntimeError, match="cleanup failed"):
        call(worker, "model.release", instance=instance)
    assert worker.instances[instance["handle"]][1] is bundle
    assert bundle.persistent_bytes == 8 and model.close_calls == 1
    assert (worker.store.path("leases", "trained", 1) / f"{instance['handle']}.json").is_file()
    before = len(case.contexts)
    with pytest.raises(PredictionError) as rejected:
        call(worker, "model.predict", instance=instance, input={"direction": "forward", "vars": {}})
    assert rejected.value.code == "instance-invalidated"
    assert len(case.contexts) == before
    with pytest.raises(PredictionError):
        worker.store.delete("models", "trained", 1)
    model.close_error = None
    call(worker, "model.release", instance=instance)
    bundle.close()
    assert model.close_calls == 2 and bundle.persistent_bytes == 0
    assert worker.instances == {}
    assert list(worker.store.path("leases", "trained", 1).glob("*.json")) == []


def test_failed_uninstalled_model_cleanup_remains_accounted_and_leased(trained_case, monkeypatch):
    case, worker = trained_case, trained_case.worker
    monkeypatch.setattr("predictor.runtime.psutil.virtual_memory", lambda: SimpleNamespace(available=1024**3))
    original_close = case.implementation.close
    def fail_after_partial_close(self):
        self.close_calls += 1
        self.persistent_bytes = 0
        raise RuntimeError("fixture partial cleanup failed")
    monkeypatch.setattr(case.implementation, "close", fail_after_partial_close)
    with pytest.raises((PredictionError, RuntimeError)):
        call(worker, "model.load", modelId="trained", revision=1, manifestChecksum="0" * 64)
    assert len(worker.instances) == 1
    instance, bundle, _ = next(iter(worker.instances.values()))
    assert case.instances[-1].close_calls == 1
    assert bundle.persistent_bytes == 8
    assert worker._model_context().available_ram_bytes == worker.memory_budget - 8
    assert (worker.store.path("leases", "trained", 1) / f"{instance['handle']}.json").is_file()
    with pytest.raises(PredictionError) as rejected:
        call(worker, "model.predict", instance=instance, input={"direction": "forward", "vars": {}})
    assert rejected.value.code == "instance-invalidated"
    with pytest.raises(PredictionError):
        worker.store.delete("models", "trained", 1)
    monkeypatch.setattr(case.implementation, "close", original_close)
    call(worker, "model.release", instance=instance)
    assert worker.instances == {}
    assert worker._failed_load_leases == {}
    worker.store.assert_unused("trained", 1)
    worker.store.delete("models", "trained", 1)


def test_failed_lease_creation_and_close_retain_read_lease_until_successful_release(trained_case, monkeypatch):
    case, worker = trained_case, trained_case.worker
    monkeypatch.setattr("predictor.runtime.psutil.virtual_memory", lambda: SimpleNamespace(available=1024**3))
    original_lease, original_close = worker.store.lease, case.implementation.close
    def fail_lease(identity, revision, handle):
        raise OSError("fixture lease write unavailable")
    def fail_close(self):
        self.close_calls += 1
        raise RuntimeError("fixture model cleanup failed")
    monkeypatch.setattr(worker.store, "lease", fail_lease)
    monkeypatch.setattr(case.implementation, "close", fail_close)
    with pytest.raises(RuntimeError, match="model cleanup failed"):
        call(worker, "model.load", modelId="trained", revision=1)
    assert len(worker.instances) == 1
    instance, bundle, _ = next(iter(worker.instances.values()))
    assert case.instances[-1].close_calls == 1
    assert bundle.persistent_bytes == 8
    assert worker._model_context().available_ram_bytes == worker.memory_budget - 8
    assert list(worker.store.path("leases", "trained", 1).glob("*.json")) == []
    assert list(worker.store.path("read-leases", "models-trained", 1).glob("*.json"))
    assert bundle in worker._failed_load_leases
    with pytest.raises(PredictionError) as protected:
        worker.store.delete("models", "trained", 1)
    assert protected.value.code == "model-in-use"
    monkeypatch.setattr(worker.store, "lease", original_lease)
    monkeypatch.setattr(case.implementation, "close", original_close)
    call(worker, "model.release", instance=instance)
    assert case.instances[-1].close_calls == 2
    assert worker.instances == worker._failed_load_leases == {}
    assert list(worker.store.path("read-leases", "models-trained", 1).glob("*.json")) == []
    worker.store.assert_unused("trained", 1)
