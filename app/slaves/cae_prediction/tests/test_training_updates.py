"""Frozen updates, verified publication and durable base-model ownership."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from prediction_contracts import validate_training_update
from predictor import training
from predictor.errors import PredictionError
from predictor.archives import create_archive, unpack_archive
from predictor.storage import encode_json
from predictor.training_operations import TrainingOperations
from predictor.transfers import OperationTransfer
from .fixtures import dataset, definition, stage
from .model_fixtures import model_case
from .test_prediction import call, runtime
from .test_training import authorize, training_spec


def next_spec(worker, initial, artifact, mode="rebuild"):
    manifest = dataset()
    manifest.update(revision=2, fingerprint="sha256:" + "b" * 64)
    manifest["measurements"].append({"id": 4, "vars": {"x": .5}})
    recorded = copy.deepcopy(manifest["recorded"][0])
    recorded.update(id=23, measurement_id=4)
    recorded["data"]["storage"]["value"] = [[[[[[[100]]]]]]]
    manifest["recorded"].append(recorded)
    target = stage(worker, manifest)
    base = {"modelId": artifact["modelId"], "revision": artifact["revision"], "checksum": artifact["manifestChecksum"],
            "storageId": worker.store.storage_id, "replicaId": "base-replica"}
    return {**initial, "operationId": "training-2", "pinId": "attempt-2", "dataset": target,
        "model": {**initial["model"], "revision": 2, "operationId": "training-2", "name": "Trained version 2"},
        "definition": {**initial["definition"], "snapshotFingerprint": target["fingerprint"], "fingerprint": "model-fingerprint-2"},
        "update": {"mode": mode, "baseModel": base, "targetSnapshot": target,
            "changeSet": {"baseSnapshot": initial["dataset"], "targetSnapshot": target,
                          "added": [4], "changed": [], "removed": []}, "recipe": {"seed": 7}}}


def complete_initial(worker, spec, monkeypatch):
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    result = worker.training.train(spec, lambda: spec["dataset"])
    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    return result["artifact"]


def test_knn_update_rebuilds_and_keeps_base_files_until_authoritative_cleanup(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    initial = training_spec(worker)
    original = complete_initial(worker, initial, monkeypatch)
    spec = next_spec(worker, initial, original)
    spec.update(canPin=True, canRelease=False, sourceKind="api")
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    fresh = runtime(tmp_path)
    with pytest.raises(PredictionError, match="base-model training"):
        fresh.store.remove_replica("models", "trained", 1)
    result = worker.training.train(spec, lambda: spec["dataset"])
    artifact = result["artifact"]
    assert artifact["update"] == spec["update"]
    assert artifact["validation"] == {"version": 1, "manifestChecksum": artifact["manifestChecksum"],
        "loadPassed": True, "predictPassed": True, "measurementId": 1}
    assert worker.store.read("models", "trained", 1)[2] == original["manifestChecksum"]
    loaded = call(worker, "model.load", modelId="trained", revision=2)
    assert call(worker, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})["output"][0]["values"] == [100]
    call(worker, "model.release", instance=loaded["instance"])
    recovered = worker.training.train(spec, lambda: pytest.fail("Saved update must not reload its Dataset."))
    assert recovered["artifact"] == artifact
    changed = copy.deepcopy(spec)
    changed["update"]["recipe"]["seed"] = 8
    with pytest.raises(PredictionError, match="another training operation"):
        worker.training.train(changed, lambda: spec["dataset"])
    spec.update(canPin=False, canRelease=True)
    call(worker, "training.unpin", grant=grant)
    fresh.store.remove_replica("models", "trained", 1)
    assert fresh.store.path("models", "trained", 2).exists()


def test_non_knn_warm_start_uses_separate_model_and_counts_base_ram(monkeypatch, model_case):
    case = model_case
    original = complete_initial(case.worker, case.spec, monkeypatch)
    spec = next_spec(case.worker, case.spec, original, "warm_start")
    spec.update(canPin=True, canRelease=False)
    grant = authorize(monkeypatch, case.worker, spec)
    call(case.worker, "training.pin", grant=grant)
    artifact = case.worker.training.train(spec, lambda: spec["dataset"])["artifact"]
    assert "update" in case.calls
    base = next(instance for instance in case.instances[2:] if instance.metadata["revision"] == 1)
    updated = next(instance for instance in case.instances if instance.metadata["revision"] == 2)
    assert base is not updated and base.output["values"] == [42]
    assert updated.output["values"] == [43]
    update_context = next(context for kind, context in case.contexts if kind == "update")
    base_context = [context for kind, context in case.contexts if kind == "load"][-2]
    assert update_context.available_ram_bytes == base_context.available_ram_bytes - 8
    assert all(instance.close_calls == 1 for instance in case.instances)
    assert case.worker.instances == {}
    assert artifact["validation"]["predictPassed"] is True
    assert case.worker.store.read("models", "trained", 1)[2] == original["manifestChecksum"]
    archive = case.worker.store.root / "updated-model.zip"
    create_archive(case.worker.store, "model", "trained", 2, archive)
    target = runtime(case.worker.store.root / "restored")
    unpack_archive(archive, target.store.path("models", "trained", 2), "model", "trained", 2, artifact["manifestChecksum"])
    loaded = call(target, "model.load", modelId="trained", revision=2)
    assert loaded["artifact"]["update"] == spec["update"]
    assert call(target, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})["output"][0]["values"] == [43]
    call(target, "model.release", instance=loaded["instance"])


@pytest.mark.parametrize("mutation", ["mode", "checksum", "snapshot", "changes"])
def test_invalid_update_is_rejected_before_base_pin(tmp_path, monkeypatch, mutation):
    worker = runtime(tmp_path)
    initial = training_spec(worker)
    artifact = complete_initial(worker, initial, monkeypatch)
    spec = next_spec(worker, initial, artifact)
    spec.update(canPin=True, canRelease=False)
    if mutation == "mode":
        spec["update"]["mode"] = "warm_start"
    elif mutation == "checksum":
        spec["update"]["baseModel"]["checksum"] = "c" * 64
    elif mutation == "snapshot":
        spec["update"]["targetSnapshot"] = {**spec["dataset"], "fingerprint": "wrong"}
    else:
        spec["update"]["changeSet"]["changed"] = [4]
    grant = authorize(monkeypatch, worker, spec)
    with pytest.raises(PredictionError):
        call(worker, "training.pin", grant=grant)
    assert not list((worker.store.path("models", "trained") / "training-pins").glob("*.json"))


def test_failed_smoke_recovers_saved_update_without_dataset(monkeypatch, model_case):
    case = model_case
    original = complete_initial(case.worker, case.spec, monkeypatch)
    spec = next_spec(case.worker, case.spec, original, "warm_start")
    spec.update(canPin=True, canRelease=False)
    grant = authorize(monkeypatch, case.worker, spec)
    call(case.worker, "training.pin", grant=grant)
    predict = case.implementation.predict
    def failed_predict(self, values, context):
        if self.metadata["revision"] == 2:
            raise PredictionError("model-validation", "Fixture validation failed")
        return predict(self, values, context)
    monkeypatch.setattr(case.implementation, "predict", failed_predict)
    with pytest.raises(PredictionError, match="validation failed"):
        case.worker.training.train(spec, lambda: spec["dataset"])
    assert case.worker.store.receipt("training-2")["state"] == "interrupted"
    assert case.worker.store.path("models", "trained", 2).exists()
    monkeypatch.setattr(case.implementation, "predict", predict)
    artifact = case.worker.training.train(spec, lambda: pytest.fail("Validation retry must use the saved smoke input."))["artifact"]
    assert artifact["validation"]["predictPassed"] is True
    assert case.calls.count("update") == 1


def test_failed_update_save_closes_both_objects_and_keeps_base_pin(monkeypatch, model_case):
    case = model_case
    original = complete_initial(case.worker, case.spec, monkeypatch)
    spec = next_spec(case.worker, case.spec, original, "warm_start")
    spec.update(canPin=True, canRelease=False)
    grant = authorize(monkeypatch, case.worker, spec)
    call(case.worker, "training.pin", grant=grant)
    write = case.implementation.write
    def failed_write(self, path, cancel=None):
        if self.metadata["revision"] == 2:
            raise OSError("Update save failed")
        return write(self, path, cancel)
    monkeypatch.setattr(case.implementation, "write", failed_write)
    with pytest.raises(OSError, match="save failed"):
        case.worker.training.train(spec, lambda: spec["dataset"])
    assert all(instance.close_calls == 1 for instance in case.instances)
    assert not case.worker.store.path("models", "trained", 2).exists()
    assert case.worker.store.read("models", "trained", 1)[2] == original["manifestChecksum"]
    with pytest.raises(PredictionError, match="base-model training"):
        case.worker.store.remove_replica("models", "trained", 1)


def test_saved_update_validates_from_its_frozen_sample_when_receipt_is_missing(tmp_path, monkeypatch):
    worker = runtime(tmp_path)
    initial = training_spec(worker)
    original = complete_initial(worker, initial, monkeypatch)
    spec = next_spec(worker, initial, original)
    spec.update(canPin=True, canRelease=False)
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    artifact = worker.training.train(spec, lambda: spec["dataset"])["artifact"]
    receipt = worker.store.path("operations", spec["operationId"]) / "receipt.json"
    receipt.unlink()
    recovered = worker.training.train(spec, lambda: pytest.fail("Frozen model smoke sample must survive a missing receipt."))["artifact"]
    assert recovered["validation"] == artifact["validation"]


@pytest.mark.parametrize("physical_failure", [False, True])
def test_server_prune_fetches_attempt_scoped_grant_and_acknowledges_removal(tmp_path, monkeypatch, physical_failure):
    worker = runtime(tmp_path)
    initial = training_spec(worker)
    complete_initial(worker, initial, monkeypatch)
    spec = {"action": "prune", "operationId": "remove-1", "replicaId": "replica-1", "modelId": "trained", "revision": 1,
            "storageId": worker.store.storage_id, "launcherId": worker.store.launcher_id,
            "accessUrl": "http://127.0.0.1:8000/cae/optimization-maintenance/jobs/job-1/attempts/attempt-1/access"}
    requests, removals, acknowledgements = [], [], []
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            return encode_json({"grant": {"operation_id": "remove-1", "token": f"ephemeral-{len(requests)}"}})
    def opened(request, timeout):
        requests.append(request)
        return Response()
    monkeypatch.setattr(worker.training.opener, "open", opened)
    monkeypatch.setattr(training.PredictorRuntime, "from_context", lambda context: worker)
    monkeypatch.setattr(OperationTransfer, "describe", lambda self: {"operation": {"id": "remove-1", "kind": "delete_replica",
        "asset_kind": "model", "asset_id": "trained", "replicas": [{"id": "replica-1", "storage_id": worker.store.storage_id,
        "revision": 1, "blocked": False}]}})
    def acknowledged(self, key, method="GET", body=None):
        acknowledgements.append(body)
        return {"state": "completed"}
    monkeypatch.setattr(OperationTransfer, "request", acknowledged)
    remove = worker.operations.run
    def run_remove(action, payload, cancel):
        removals.append((action, payload))
        return remove(action, payload, cancel)
    monkeypatch.setattr(worker.operations, "run", run_remove)
    context = SimpleNamespace(execution=SimpleNamespace(allocation=SimpleNamespace(model_dump=lambda: {})),
                              assignment={"attempt_id": "attempt-1", "token": "assignment"}, job_id="job-1")
    if physical_failure:
        remove_files = worker.store._remove
        failures = []
        def transient_remove(path):
            if path.name == ".removing-1" and not failures:
                failures.append(path)
                raise PermissionError("Fixture file temporarily locked")
            return remove_files(path)
        monkeypatch.setattr(worker.store, "_remove", transient_remove)
        with pytest.raises(PermissionError, match="temporarily locked"):
            asyncio.run(training.run_training(spec, [], context))
        assert worker.store.receipt("remove-1")["state"] == "interrupted"
        assert acknowledgements == []
        assert (worker.store.path("models", "trained") / ".removing-1" / "model.json").is_file()
        assert not worker.store.deleted("trained", 1)
        spec["accessUrl"] = spec["accessUrl"].replace("job-1", "job-2").replace("attempt-1", "attempt-2")
        context.job_id, context.assignment = "job-2", {"attempt_id": "attempt-2", "token": "assignment-2"}
    result = asyncio.run(training.run_training(spec, [], context))
    assert result == {"operationId": "remove-1", "replicaId": "replica-1", "removed": True}
    assert requests[0].headers["Authorization"] == "Bearer assignment"
    assert removals[0][0] == "artifact.remove" and removals[0][1]["identity"] == "trained"
    assert not worker.store.path("models", "trained", 1).exists()
    assert not list(worker.store.path("models", "trained").glob(".removing-*"))
    assert not worker.store.deleted("trained", 1)
    assert acknowledgements == [{"replica_id": "replica-1"}]
    assert worker.store.receipt("remove-1")["state"] == "complete"
    if physical_failure:
        assert requests[-1].headers["Authorization"] == "Bearer assignment-2"
        assert removals[-1][1]["grant"]["token"] == "ephemeral-2"
    spec["accessUrl"] = spec["accessUrl"].replace(context.assignment["attempt_id"], "foreign-attempt")
    with pytest.raises(PredictionError, match="another execution attempt"):
        asyncio.run(training.run_training(spec, [], context))


@pytest.mark.parametrize("provide_pin", [True, False])
def test_server_update_consumes_real_dataset_and_pin_grants(tmp_path, monkeypatch, provide_pin):
    worker = runtime(tmp_path)
    initial = training_spec(worker)
    original = complete_initial(worker, initial, monkeypatch)
    spec = next_spec(worker, initial, original)
    spec.update(canPin=True, canRelease=False, sourceKind="api")
    content = (worker.store.path("datasets", "dataset-1", 2) / "dataset.json").read_bytes()
    dataset_reads, acknowledgements = [], []
    grant = {}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path.endswith("/attempts/attempt-2/dataset"):
                assert self.headers["Authorization"] == "Bearer assignment"
                dataset_reads.append(self.path)
                response = {"grant": grant}
                if provide_pin:
                    response["trainingGrant"] = {"operation_id": "training-2", "token": "pin",
                        "manifest_url": worker.training.api_url + "/prediction/operations/training-2/training"}
                raw = encode_json(response)
            elif self.path == "/prediction/operations/training-2/training":
                assert self.headers["Authorization"] == "Bearer pin"
                raw = encode_json(spec)
            else:
                assert self.path == "/prediction/datasets/dataset-1/revisions/2/manifest"
                assert self.headers["Authorization"] == "Bearer dataset"
                raw = content
            self.send_response(200)
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            assert self.path == "/prediction/operations/training-2/training/pinned"
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert (worker.store.path("models", "trained") / "training-pins" / "attempt-2.json").is_file()
            acknowledgements.append(value)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    worker.training.api_url = worker.reader.api_url = f"http://127.0.0.1:{server.server_address[1]}"
    spec["datasetAccessUrl"] = worker.training.api_url + "/prediction/training/jobs/job-2/attempts/attempt-2/dataset"
    grant.update(dataset_id="dataset-1", revision=2, fingerprint=spec["dataset"]["fingerprint"],
        token="dataset", manifest_sha256=hashlib.sha256(content).hexdigest(),
        manifest_url=worker.training.api_url + "/prediction/datasets/dataset-1/revisions/2/manifest",
        object_url_template=worker.training.api_url + "/prediction/datasets/dataset-1/revisions/2/objects/{id}")
    monkeypatch.setattr(worker.training, "authority", TrainingOperations.authority.__get__(worker.training))
    monkeypatch.setattr(worker.training, "_ack_pin", TrainingOperations._ack_pin.__get__(worker.training))
    monkeypatch.setattr(training.PredictorRuntime, "from_context", lambda context: worker)
    async def send(message):
        pass
    context = SimpleNamespace(execution=SimpleNamespace(allocation=SimpleNamespace(model_dump=lambda: {"cpu_cores": 1, "gpu_devices": []})),
        assignment={"attempt_id": "attempt-2", "token": "assignment"}, job_id="job-2", send=send)
    try:
        if provide_pin:
            result = asyncio.run(training.run_training(spec, [], context))
            assert result["artifact"]["validation"]["predictPassed"] is True
            assert acknowledgements == [{"pinId": "attempt-2", "artifactSaved": False}]
            recovered = asyncio.run(training.run_training(spec, [], context))
            assert recovered["artifact"] == result["artifact"]
        else:
            with pytest.raises(PredictionError, match="pin grants"):
                asyncio.run(training.run_training(spec, [], context))
            assert not worker.store.path("models", "trained", 2).exists()
        assert len(dataset_reads) == 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_shared_update_modes_do_not_claim_checkpoint_resume():
    manifest = dataset()
    assert validate_training_update(None, definition(manifest)) == "rebuild"
