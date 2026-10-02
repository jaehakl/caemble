from __future__ import annotations

import asyncio
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

import pytest

from prediction_contracts import ALGORITHMS, resource_requirements, validate_definition
from predictor import models
from predictor.archives import create_archive, unpack_archive
from predictor.errors import PredictionError
from predictor.storage import encode_json
from .fixtures import dataset, definition, stage
from .test_prediction import call, runtime


def training_spec(worker):
    manifest = dataset()
    reference = stage(worker, manifest)
    return {"operationId": "training-1", "pinId": "attempt-1", "storageId": worker.store.storage_id,
            "launcherId": worker.store.launcher_id, "sourceKind": "local", "canPin": True, "canRelease": False,
            "model": {"modelId": "trained", "revision": 1, "operationId": "training-1", "name": "Trained"},
            "definition": definition(manifest), "dataset": reference}


def authorize(monkeypatch, worker, spec):
    grant = {"operation_id": spec["operationId"], "manifest_url": worker.training.api_url + "/prediction/operations/training-1/training",
             "token": spec["pinId"]}
    def authority(value, cancel=None):
        if value["token"] != spec["pinId"]:
            raise PredictionError("data-access", "Stale pin token.")
        return copy.deepcopy(spec)
    monkeypatch.setattr(worker.training, "authority", authority)
    monkeypatch.setattr(worker.training, "_ack_pin", lambda value, pin, saved, cancel=None: {"operationId": value["operation_id"], "pinId": pin})
    return grant


def test_pin_survives_browser_and_process_cleanup_is_authoritative(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    assert call(worker, "training.pin", grant=grant)["pinId"] == "attempt-1"
    fresh = runtime(tmp_path)
    for current in (worker, fresh):
        with pytest.raises(PredictionError, match="cleanup"):
            current.store.delete("datasets", "dataset-1")
        with pytest.raises(PredictionError, match="cleanup"):
            current.store.publish_dataset("dataset-1", 2)
    with pytest.raises(PredictionError, match="cleanup"):
        call(worker, "training.unpin", grant=grant)
    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    fresh.store.delete("datasets", "dataset-1")


def test_sync_reconciles_abandoned_preflight_but_keeps_pin_when_api_unavailable(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    authority = worker.training.authority
    monkeypatch.setattr(worker.training, "authority", lambda *_: (_ for _ in ()).throw(OSError("offline")))
    worker.training.reconcile_dataset("dataset-1")
    with pytest.raises(PredictionError, match="cleanup"):
        worker.store.assert_dataset_idle("dataset-1")
    monkeypatch.setattr(worker.training, "authority", authority)
    spec.update(canPin=False, canRelease=True)
    worker.training.reconcile_dataset("dataset-1")
    worker.store.assert_dataset_idle("dataset-1")


def test_retry_pin_fences_stale_cleanup(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    old_grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=old_grant)
    spec["pinId"] = "attempt-2"
    new_grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=new_grant)
    with pytest.raises(PredictionError, match="Stale"):
        call(worker, "training.unpin", grant=old_grant)
    pins = list((worker.store.path("datasets", "dataset-1") / "training-pins").glob("*.json"))
    assert [pin.stem for pin in pins] == ["attempt-2"]


def test_delayed_pin_authority_cannot_replace_newer_attempt_pin(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    old_spec = copy.deepcopy(spec)
    spec["pinId"] = "attempt-2"
    new_grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=new_grant)
    reads = []
    def delayed_authority(grant, cancel=None):
        reads.append(grant["token"])
        return old_spec if len(reads) == 1 else {**old_spec, "canPin": False, "canRelease": True}
    monkeypatch.setattr(worker.training, "authority", delayed_authority)
    with pytest.raises(PredictionError, match="replaced"):
        call(worker, "training.pin", grant={**new_grant, "token": "attempt-1"})
    pins = list((worker.store.path("datasets", "dataset-1") / "training-pins").glob("*.json"))
    assert [pin.stem for pin in pins] == ["attempt-2"]


def test_training_publishes_without_handle_and_recovers_after_dataset_is_gone(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    result = worker.training.train(spec, lambda: spec["dataset"])
    assert worker.instances == {}
    assert worker.store.receipt(spec["operationId"])["state"] == "saved"
    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    worker.store.delete("datasets", "dataset-1")
    fresh = runtime(tmp_path)
    recovered = fresh.training.train(spec, lambda: pytest.fail("Saved-model recovery must not read Dataset access."))
    assert recovered["artifact"]["manifestChecksum"] == result["artifact"]["manifestChecksum"]
    loaded = call(fresh, "model.load", modelId="trained", revision=1)
    assert loaded["instance"]["executionId"] == "remote-predictor"
    assert call(fresh, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})["output"][0]["values"] == [15]


def test_missing_exact_dataset_never_falls_back_to_latest(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    updated = dataset()
    updated.update(revision=2, fingerprint="sha256:" + "b" * 64)
    stage(worker, updated)
    grant = authorize(monkeypatch, worker, spec)
    with pytest.raises(PredictionError, match="missing"):
        call(worker, "training.pin", grant=grant)
    assert worker.store.list("models") == []


def test_training_inspection_is_responsive_and_model_is_protected_during_training(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    started, release = threading.Event(), threading.Event()
    def progress(stage):
        if stage == "training":
            started.set()
            assert release.wait(5)
    with ThreadPoolExecutor(max_workers=2) as executor:
        training = executor.submit(worker.training.train, spec, lambda: spec["dataset"], None, progress)
        assert started.wait(5)
        try:
            inspected = executor.submit(call, worker, "training.inspect", grant=grant).result(timeout=1)
            assert inspected["receipt"]["state"] == "preparing"
            with pytest.raises(PredictionError, match="Release"):
                runtime(tmp_path).store.delete("models", "trained", 1)
        finally:
            release.set()
        assert training.result(timeout=5)["artifact"]["revision"] == 1


def test_allocated_session_preserves_deleted_revision_error(tmp_path):
    worker = runtime(tmp_path)
    worker.store.delete("models", "removed", 1)
    worker.allocation = {"cpu_cores": 1, "gpu_devices": []}
    with pytest.raises(PredictionError) as raised:
        call(worker, "model.load", modelId="removed", revision=1)
    assert raised.value.code == "deleted"


def test_cancelled_training_never_publishes_or_unpins_before_cleanup(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    cancelled = threading.Event()
    def progress(stage):
        if stage == "training":
            cancelled.set()
    with pytest.raises(PredictionError, match="cancelled"):
        worker.training.train(spec, lambda: spec["dataset"], cancelled, progress)
    assert not worker.store.list("models")
    assert worker.store.receipt(spec["operationId"])["state"] == "cancelled"
    with pytest.raises(PredictionError, match="cleanup"):
        worker.store.assert_dataset_idle("dataset-1")


def test_old_wire_and_synchronous_prepare_are_rejected(tmp_path):
    worker = runtime(tmp_path)
    with pytest.raises(PredictionError, match="v3"):
        worker.dispatch("predictor.hello", {"protocolVersion": 2, "requestId": "old"})
    with pytest.raises(PredictionError, match="durable"):
        call(worker, "model.prepare")
    hello = call(worker, "predictor.hello")
    assert hello["algorithmDescriptors"][0]["kind"] == "knn"
    assert "implementationVersion" not in hello


def test_training_pin_fetches_authority_and_acknowledges_only_after_durable_pin(tmp_path):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    acknowledgements = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            assert self.headers["Authorization"] == "Bearer scoped-training"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(encode_json(spec))

        def do_POST(self):
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            pin = worker.store.path("datasets", "dataset-1") / "training-pins" / "attempt-1.json"
            assert pin.is_file()
            acknowledgements.append(value)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{}')

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    worker.training.api_url = f"http://127.0.0.1:{server.server_address[1]}"
    grant = {"operation_id": "training-1", "token": "scoped-training",
             "manifest_url": worker.training.api_url + "/prediction/operations/training-1/training"}
    try:
        call(worker, "training.pin", grant=grant)
        assert acknowledgements == [{"pinId": "attempt-1", "artifactSaved": False}]
        with pytest.raises(PredictionError, match="trusted"):
            call(worker, "training.pin", grant={**grant, "manifest_url": "https://other.invalid/prediction/operations/training-1/training"})
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_api_source_recovery_can_ack_saved_artifact_without_dataset(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    worker.training.train(spec, lambda: spec["dataset"])
    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    worker.store.delete("datasets", "dataset-1")
    spec.update(sourceKind="api", canPin=True, canRelease=False)
    saved_flags = []
    monkeypatch.setattr(worker.training, "_ack_pin", lambda grant, pin, saved, cancel=None: saved_flags.append(saved) or {})
    call(worker, "training.pin", grant=grant)
    assert saved_flags == [True]


@pytest.mark.parametrize("invalid", [None, [], {"algorithm": []}, {"algorithm": {"kind": []}}, {"algorithm": {"kind": "missing"}}])
def test_shared_contract_rejects_malformed_definitions(invalid):
    with pytest.raises(ValueError):
        validate_definition(invalid)


def test_second_algorithm_owns_artifacts_and_metadata_without_knn_groups(tmp_path, monkeypatch):
    descriptor = {**copy.deepcopy(ALGORITHMS["knn"]), "kind": "fixture", "implementationVersion": "fixture-v1"}
    descriptor["resources"]["training"] = {"cpu_cores": 2, "gpu_count": 1, "gpu_memory_bytes": 128}
    monkeypatch.setitem(ALGORITHMS, "fixture", descriptor)
    implementation_calls = []

    class FixtureModel:
        def __init__(self, metadata):
            self.metadata, self.persistent_bytes = metadata, 8
            self.input_layouts, self.output_layouts = [], []

        @classmethod
        def prepare(cls, data, model_definition, model_ref, memory_budget, cancel=None, progress=None):
            implementation_calls.append("prepare")
            if progress:
                progress({"stage": "training", "fraction": .5, "metrics": {"loss": 1.0}})
            return cls({**model_ref, "formatVersion": 1, "direction": "forward", "algorithm": "fixture",
                        "definition": model_definition, "datasetId": data["datasetId"], "datasetRevision": data["revision"],
                        "datasetFingerprint": data["fingerprint"], "experimentId": data["experimentId"]})

        def profile(self):
            return {"rowCount": 1}

        def preparation_details(self):
            return {"rules": [], "recordProfiles": [], "errors": {}}

        def predict(self, values, cancel=None):
            return {"direction": "forward", "output": [], "value": 42}

        def write(self, path, cancel=None):
            (path / "model.json").write_bytes(encode_json({"metadata": self.metadata, "value": 42}))

        @classmethod
        def load(cls, metadata, content, path, files, memory_budget, cancel=None):
            implementation_calls.append("load")
            assert content["value"] == 42
            return cls(metadata)

        @staticmethod
        def validate_artifact(path, manifest, content):
            implementation_calls.append("validate")
            assert content["value"] == 42
            return {"model.json"}

    monkeypatch.setitem(models.IMPLEMENTATIONS, "fixture", FixtureModel)
    worker = runtime(tmp_path / "source")
    spec = training_spec(worker)
    spec["definition"].update(algorithm={"kind": "fixture"}, implementationVersion="fixture-v1")
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    updates = []
    trained = worker.training.train(spec, lambda: spec["dataset"], progress=updates.append)
    assert {"stage": "training", "fraction": .5, "metrics": {"loss": 1.0}} in updates
    assert resource_requirements(spec["definition"], "training")["gpu_count"] == 1
    assert resource_requirements(spec["definition"], "inference")["gpu_count"] == 0
    assert implementation_calls == ["prepare"]
    assert worker.instances == {}

    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    worker.store.delete("datasets", spec["dataset"]["datasetId"])
    recovered = runtime(tmp_path / "source")
    retried = recovered.training.train(spec, lambda: pytest.fail("Completed model recovery must not access its Dataset."))
    assert retried["artifact"]["manifestChecksum"] == trained["artifact"]["manifestChecksum"]
    assert implementation_calls == ["prepare", "validate"]
    assert recovered.instances == {}

    verified = call(recovered, "artifact.verify", kind="model", identity="trained", revision=1,
                    manifestChecksum=trained["artifact"]["manifestChecksum"])
    assert verified["state"] == "present"
    archive = tmp_path / "fixture.zip"
    create_archive(recovered.store, "model", "trained", 1, archive)
    target = runtime(tmp_path / "target")
    unpack_archive(archive, target.store.path("models", "trained", 1), "model", "trained", 1, trained["artifact"]["manifestChecksum"])
    assert implementation_calls.count("prepare") == 1
    assert implementation_calls.count("validate") >= 3
    assert "load" not in implementation_calls
    assert recovered.instances == target.instances == {}
    loaded = call(target, "model.load", modelId="trained", revision=1)
    assert implementation_calls.count("load") == 1
    assert loaded["rules"] == []
    assert call(target, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {}})["value"] == 42


def test_server_cancellation_waits_for_training_thread_cleanup(tmp_path, monkeypatch):
    from predictor import training
    worker = runtime(tmp_path)
    spec = training_spec(worker)
    started, cleaned = threading.Event(), threading.Event()
    def train(spec, reference, cancel, progress):
        started.set()
        cancel.wait(5)
        cleaned.set()
        raise PredictionError("cancelled", "Stopped")
    monkeypatch.setattr(worker.training, "train", train)
    monkeypatch.setattr(training.PredictorRuntime, "from_context", lambda context: worker)
    context = SimpleNamespace(execution=SimpleNamespace(allocation=SimpleNamespace(model_dump=lambda: {"cpu_cores": 1, "gpu_devices": []})))
    async def scenario():
        task = asyncio.create_task(training.run_training(spec, [], context))
        await asyncio.to_thread(started.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cleaned.is_set()
    asyncio.run(scenario())
