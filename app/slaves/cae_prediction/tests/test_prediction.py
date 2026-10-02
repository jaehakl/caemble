from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

from predictor.errors import PredictionError
from predictor.execution import ModelExecutionContext
from predictor.knn import KnnModel
from predictor.models import ModelBundle
from predictor.representations import recorded_sample
from predictor.runtime import PredictorRuntime
from predictor.storage import ArtifactStore, encode_json
from .fixtures import dataset, definition, stage


def runtime(tmp_path):
    return PredictorRuntime(tmp_path, "owner-1", "launcher-1", "http://127.0.0.1:8000", 128 * 1024 * 1024)


def call(worker, action, **payload):
    return worker.dispatch(action, {"protocolVersion": 3, "requestId": "request-1", "sessionId": worker.session_id, **payload})


def prepare_saved(worker, *, dataset, direction, definition, model):
    bundle = ModelBundle.prepare(worker.reader.load(dataset, definition=definition), direction, definition,
                                 model, worker._model_context(None))
    try:
        bundle.save(worker.store)
    finally:
        bundle.close()
    return call(worker, "model.load", modelId=model["modelId"], revision=model["revision"])


def prepare(worker, direction="forward", manifest=None, **algorithm):
    manifest = manifest or dataset()
    reference = stage(worker, manifest)
    return prepare_saved(worker, dataset=reference, direction=direction, definition=definition(manifest, **algorithm),
                model={"modelId": f"model-{direction}", "revision": 1, "operationId": "operation-1", "name": direction})


def test_forward_relative_coordinates(tmp_path):
    worker = runtime(tmp_path)
    manifest = dataset()
    for index, row in enumerate(manifest["recorded"]):
        row["data"] = copy.deepcopy(row["data"])
        row["data"]["axes"][0]["ticks"] = [100 + index]
        row["data"]["boxGrid"]["lengthUnit"] = "mm" if index else "m"
        for axis in row["data_schema"]["axes"][:3]:
            axis["unit"] = row["data"]["boxGrid"]["lengthUnit"]
        row["data"]["boxGrid"]["rotation"] = [[0, -1, 0], [1, 0, 0], [0, 0, 1]] if index else [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    forward = prepare(worker, manifest=manifest)
    result = call(worker, "model.predict", instance=forward["instance"], input={"direction": "forward", "vars": {"x": .5}})
    assert result["output"][0]["values"] == pytest.approx([15])
    assert result["knn"]["neighbors"] == [
        {"measurementId": 1, "distanceSquared": .0625, "weight": .5},
        {"measurementId": 2, "distanceSquared": .0625, "weight": .5}]
    assert forward["profile"]["rowCount"] == 3


def test_batch_matches_single_and_preserves_candidate_and_model_identity(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    inputs = [{"candidateId": f"trial-{index}", "input": {"direction": "forward", "vars": {"x": index / 4}}} for index in range(3)]
    batch = call(worker, "model.predict_batch", instance=prepared["instance"], inputs=inputs)
    assert len(worker.instances) == 1
    for item, result in zip(inputs, batch["predictions"]):
        single = call(worker, "model.predict", instance=prepared["instance"], input=item["input"])
        assert result["candidateId"] == item["candidateId"]
        assert result["output"] == single["output"]
        assert result["provenance"] == {**single["provenance"], "manifestChecksum": prepared["artifact"]["manifestChecksum"]}
    for invalid in ([], inputs * 11, [inputs[0], inputs[0]]):
        with pytest.raises(PredictionError, match="inputs|unique"):
            call(worker, "model.predict_batch", instance=prepared["instance"], inputs=invalid)


def test_restart_reloads_without_dataset_or_training(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    call(worker, "model.release", instance=prepared["instance"])
    call(worker, "dataset.delete", datasetId="dataset-1")
    script = r'''
import importlib.util,json,sys
from pathlib import Path
package=Path(sys.argv[1]); sys.path.insert(0,str(package.parents[3]/"shared")); spec=importlib.util.spec_from_file_location("predictor",package/"__init__.py",submodule_search_locations=[str(package)])
module=importlib.util.module_from_spec(spec);sys.modules["predictor"]=module;spec.loader.exec_module(module)
from predictor.runtime import PredictorRuntime
worker=PredictorRuntime(Path(sys.argv[2]),"owner-1","launcher-1","http://127.0.0.1:8000",128*1024*1024)
base={"protocolVersion":3,"requestId":"restart","sessionId":worker.session_id}
loaded=worker.dispatch("model.load",dict(base,modelId="model-forward",revision=1))
result=worker.dispatch("model.predict",dict(base,instance=loaded["instance"],input={"direction":"forward","vars":{"x":.5}}))
print(json.dumps({"instance":loaded["instance"],"result":result,"datasets":worker.store.list("datasets")}))
'''
    completed = subprocess.run([sys.executable, "-c", script, str(Path(__file__).parents[1] / "app"), str(tmp_path)], check=True, text=True, capture_output=True)
    response = json.loads(completed.stdout)
    assert response["result"]["output"][0]["values"] == pytest.approx([15])
    assert response["instance"]["sessionId"] != prepared["instance"]["sessionId"]
    assert response["datasets"] == []
    with pytest.raises(PredictionError, match="not loaded"):
        call(worker, "model.predict", instance=prepared["instance"], input={"direction": "forward", "vars": {"x": 1}})


def test_idempotent_prepare_delete_tombstone_and_owner_isolation(tmp_path):
    worker = runtime(tmp_path)
    first, second = prepare(worker), prepare(worker)
    assert first["artifact"]["manifestChecksum"] == second["artifact"]["manifestChecksum"]
    assert len(worker.store.list("models")) == 1
    other = PredictorRuntime(tmp_path, "owner-2", "launcher-1", "http://127.0.0.1:8000", 1000000)
    assert other.store.list("models") == []
    assert worker.store.storage_id == other.store.storage_id
    with pytest.raises(PredictionError, match="Release"):
        call(worker, "model.delete", modelId="model-forward")
    call(worker, "model.release", instance=first["instance"])
    call(worker, "model.release", instance=second["instance"])
    call(worker, "model.delete", modelId="model-forward")
    with pytest.raises(PredictionError, match="deleted"):
        prepare(worker)


def test_checksums_partial_write_and_cancellation(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    with pytest.raises(PredictionError, match="registered model"):
        call(worker, "model.load", modelId="model-forward", revision=1, manifestChecksum="0" * 64)
    path = worker.store.path("models", "model-forward", 1) / "0-input.npy"
    path.write_bytes(path.read_bytes()[:-1])
    with pytest.raises(PredictionError, match="length"):
        call(worker, "model.load", modelId="model-forward", revision=1)
    assert worker.store.list("models")[0]["available"] is False
    def fail(path):
        (path / "partial").write_bytes(b"partial")
        raise OSError("disk full")
    with pytest.raises(OSError):
        worker.store.write("models", "failed", 1, {}, fail)
    assert not worker.store.path("models", "failed", 1).exists()
    cancellation = threading.Event()
    def cancel(path):
        (path / "partial").write_bytes(b"partial")
        cancellation.set()
    with pytest.raises(PredictionError, match="cancelled"):
        worker.store.write("models", "cancelled", 1, {}, cancel, cancellation)
    assert not worker.store.path("models", "cancelled", 1).exists()


def test_dataset_sync_replaces_payload_but_models_survive(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    updated = dataset()
    updated["revision"] = 2
    updated["measurements"] = updated["measurements"][1:]
    updated["fingerprint"] = "sha256:" + "b" * 64
    stage(worker, updated)
    assert worker.store.latest_dataset("dataset-1") == 2
    assert not worker.store.path("datasets", "dataset-1", 1).exists()
    assert prepared["artifact"]["datasetRevision"] == 1
    loaded = call(worker, "model.load", modelId="model-forward", revision=1)
    assert loaded["profile"]["rowCount"] == 3


def test_invalid_sample_excluded_without_requiring_calculations(tmp_path):
    manifest = dataset()
    manifest.pop("calculations")
    manifest.pop("calculationData")
    manifest["recorded"][0]["data"]["storage"]["value"] = [[[[[[[None]]]]]]]
    prepared = prepare(runtime(tmp_path), manifest=manifest)
    assert prepared["profile"]["includedMeasurementIds"] == [2, 3]
    assert prepared["profile"]["excluded"]["missing-block"] == 1
    assert "calculationWeights" not in prepared["artifact"]["definition"]["algorithm"]


def test_memory_limit_not_browser_cell_limit(tmp_path):
    worker = runtime(tmp_path)
    worker.memory_budget = 1
    with pytest.raises(PredictionError) as error:
        prepare(worker)
    assert error.value.code == "memory-limit"
    assert not worker.store.list("models")


def test_local_import_validates_checksums_and_rejects_paths(tmp_path):
    worker = runtime(tmp_path)
    manifest = dataset()
    source = worker.store.namespace / "imports" / "fixture"
    source.mkdir(parents=True)
    raw = encode_json(manifest)
    (source / "dataset.json").write_bytes(raw)
    bundle = {"kind": "caemble.prediction.dataset.artifact", "version": 1, "identity": manifest["datasetId"], "revision": 1,
              "metadata": {}, "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}
    (source / "manifest.json").write_bytes(encode_json(bundle))
    with pytest.raises(PredictionError, match="different Experiment"):
        call(worker, "dataset.import", importId="fixture", experimentId=manifest["experimentId"] + 1)
    assert worker.store.list("datasets") == []
    result = call(worker, "dataset.import", importId="fixture")
    assert result["dataset"]["sourceKind"] == "local"
    assert result["dataset"]["sampleCount"] == 3
    assert result["dataset"]["datasetId"] != manifest["datasetId"]
    assert result["dataset"]["origin"]["datasetId"] == manifest["datasetId"]
    assert result["dataset"]["operationId"]
    (source / "dataset.json").write_bytes(raw + b" ")
    with pytest.raises(PredictionError, match="length"):
        call(worker, "dataset.import", importId="fixture")
    for identity in ("../secret", "C:\\secret", "/secret"):
        with pytest.raises(PredictionError):
            call(worker, "dataset.import", importId=identity)


def test_manual_local_sync_updates_added_removed_rows_and_keeps_saved_model(tmp_path):
    worker = runtime(tmp_path)
    source = worker.store.namespace / "imports" / "source"
    source.mkdir(parents=True)
    def write_source(manifest):
        raw = encode_json(manifest)
        (source / "dataset.json").write_bytes(raw)
        (source / "manifest.json").write_bytes(encode_json({"kind": "caemble.prediction.dataset.artifact", "version": 1,
            "identity": manifest["datasetId"], "revision": manifest["revision"], "metadata": {},
            "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}))
    manifest = dataset()
    write_source(manifest)
    imported = call(worker, "dataset.import", importId="source")["dataset"]
    again = call(worker, "dataset.import", importId="source")["dataset"]
    assert again["datasetId"] == imported["datasetId"]
    assert again["operationId"] == imported["operationId"]
    prepared = prepare_saved(worker, dataset=imported, direction="forward", definition=definition(manifest),
                    model={"modelId": "local-model", "revision": 1, "operationId": "op", "name": "Local"})
    manifest["revision"] = 7
    manifest["measurements"] = manifest["measurements"][1:]
    manifest["recorded"] = manifest["recorded"][1:]
    manifest["calculationData"] = manifest["calculationData"][1:]
    manifest["fingerprint"] = "sha256:" + "b" * 64
    write_source(manifest)
    synchronized = call(worker, "dataset.sync", datasetId=imported["datasetId"])["dataset"]
    assert synchronized["datasetId"] == imported["datasetId"]
    assert synchronized["revision"] == 2
    assert synchronized["origin"]["revision"] == 7
    assert synchronized["sampleCount"] == 2
    assert not worker.store.path("datasets", imported["datasetId"], 1).exists()
    summaries = worker.store.list("datasets")
    assert [item["revision"] for item in summaries] == [1, 2]
    assert summaries[0]["registrationReceipt"] is True
    assert summaries[0]["payloadAvailable"] is False
    assert summaries[0]["operationId"] == imported["operationId"]
    assert summaries[1]["available"] is True
    assert call(worker, "dataset.sync", datasetId=imported["datasetId"])["dataset"]["revision"] == 2
    loaded = call(worker, "model.load", modelId="local-model", revision=1)
    assert loaded["profile"]["rowCount"] == 3
    assert loaded["artifact"]["manifestChecksum"] == prepared["artifact"]["manifestChecksum"]
    call(worker, "dataset.delete", datasetId=imported["datasetId"])
    with pytest.raises(PredictionError, match="deleted"):
        call(worker, "dataset.import", importId="source")


def test_local_dataset_preview_counts_content_without_publishing(tmp_path):
    worker = runtime(tmp_path)
    source = worker.store.namespace / "imports" / "preview"
    source.mkdir(parents=True)
    manifest = dataset()
    def update_source():
        raw = encode_json(manifest)
        (source / "dataset.json").write_bytes(raw)
        (source / "manifest.json").write_bytes(encode_json({"kind": "caemble.prediction.dataset.artifact", "version": 1,
            "identity": manifest["datasetId"], "revision": manifest["revision"], "metadata": {},
            "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}))
    update_source()
    imported = call(worker, "dataset.import", importId="preview")["dataset"]
    unchanged = call(worker, "dataset.preview", datasetId=imported["datasetId"])
    assert {key: unchanged[key] for key in ("added", "changed", "removed")} == {"added": 0, "changed": 0, "removed": 0}
    manifest["measurements"] = [manifest["measurements"][0], {**manifest["measurements"][1], "vars": {"x": 1.25}}, {"id": 4, "vars": {"x": 1.5}}]
    manifest.update(revision=2, fingerprint="sha256:" + "c" * 64)
    update_source()
    result = call(worker, "dataset.preview", datasetId=imported["datasetId"])
    assert {key: result[key] for key in ("added", "changed", "removed")} == {"added": 1, "changed": 1, "removed": 1}
    assert worker.store.latest_dataset(imported["datasetId"]) == 1
    assert len(worker.store.list("datasets")) == 1


def test_polar_and_modal_groups_use_correct_numerical_representation(tmp_path):
    manifest = dataset()
    for rule in manifest["rules"]:
        rule["result"]["boxGrid"].update({"channels": ["amplitude", "phase"], "channelUnits": ["K", "rad"], "frequencyKind": "modal"})
    for index, row in enumerate(manifest["recorded"]):
        row["data_schema"]["boxGrid"].update({"channels": ["amplitude", "phase"], "channelUnits": ["K", "rad"], "frequencyKind": "modal"})
        row["data"]["boxGrid"].update({"channels": ["amplitude", "phase"], "channelUnits": ["K", "rad"], "frequencyKind": "modal"})
        row["data"]["shape"][5] = 2
        row["data"]["axes"][5]["ticks"] = ["amplitude", "phase"]
        row["data"]["axes"][4]["ticks"] = [100 + index * 10]
        value = [[1], [np.pi - .1 if index == 0 else -np.pi + .1]]
        for _ in range(5):
            value = [value]
        row["data"]["storage"]["value"] = value
    context = ModelExecutionContext(allocation=None, available_ram_bytes=1000000)
    bundle = ModelBundle.prepare(manifest, "forward", definition(manifest, kMode="manual", manualK=3), {"modelId": "m", "revision": 1, "operationId": "o", "name": "n"}, context)
    try:
        predicted = bundle.predict({"direction": "forward", "vars": {"x": .5}}, context)
    finally:
        bundle.close()
    assert predicted["knn"]["neighbors"] == [{"measurementId": 1, "distanceSquared": .0625, "weight": 1.0}]
    assert predicted["output"][0]["values"][-1] == 100
    assert predicted["output"][0]["values"][:2] == pytest.approx([-np.cos(.1), np.sin(.1)])


def test_zero_distance_uses_all_exact_rows():
    sample = lambda key, value, **extra: {"layout": {"key": key, "dtype": "float64", "shape": [], **extra}, "values": [value]}
    rows = [{"measurementId": index + 1, "inputs": [sample("x", 1, minimum=0, maximum=2)], "outputs": [sample("temperature", value)]}
            for index, value in enumerate((1, 2, 9))]
    model = KnnModel.build(rows, fingerprint="f", input_keys=["x"], output_keys=["temperature"],
                           algorithm={"kMode": "manual", "manualK": 1, "weighting": "distance"}, memory_budget=1000000)
    result = model.predict([sample("x", 1, minimum=0, maximum=2)])
    assert len(result["knn"]["neighbors"]) == 3
    assert result["output"][0]["values"] == [4]


def test_fixed_forward_numerical_contract_fixture():
    fixture = json.loads(Path(__file__).with_name("forward_reference.json").read_text(encoding="utf-8"))
    for case in fixture["cases"]:
        options = case["options"]
        algorithm = {"kMode": "manual", "manualK": options["k"], "weighting": options["weighting"]}
        model = KnnModel.build(options["rows"], fingerprint=case["name"],
                               input_keys=options["inputKeys"], output_keys=options["outputKeys"], algorithm=algorithm,
                               memory_budget=1000000, nearest_only=options.get("nearestOnly", False))
        result = model.predict(case["query"])
        assert model.arrays["inputScales"].tolist() == pytest.approx(case["inputScales"], rel=1e-12, abs=1e-12), case["name"]
        for actual, expected in zip(result["output"], case["expected"]["output"]):
            assert actual["values"] == pytest.approx(expected["values"], rel=1e-12, abs=1e-12), case["name"]
        assert result["extrapolatedInputKeys"] == case["expected"]["extrapolatedInputKeys"]
        assert result["constantInputKeysChanged"] == case["expected"]["constantInputKeysChanged"]
        for actual, expected in zip(result["knn"]["neighbors"], case["expected"]["neighbors"]):
            assert actual == pytest.approx(expected, rel=1e-12, abs=1e-12), case["name"]


def test_direct_scoped_grant_preparation_verifies_chunks_without_retaining_dataset(tmp_path):
    manifest = dataset()
    object_bytes = encode_json(manifest["recorded"][0]["data"]["storage"]["value"])
    object_ref = {"kind": "caemble.object", "version": 1, "id": "object-1", "encoding": "json",
                  "sha256": hashlib.sha256(object_bytes).hexdigest(), "byteLength": len(object_bytes)}
    manifest["recorded"][0]["data"]["storage"]["value"] = object_ref
    raw = encode_json(manifest)
    requested = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requested.append((self.path, self.headers.get("Authorization")))
            if self.path.endswith("/manifest"):
                data = raw
            elif self.path.endswith("/objects/object-1"):
                data = encode_json({"reference": object_ref, "parts": [{"url": origin + "/blob", "sha256": object_ref["sha256"], "byteLength": len(object_bytes)}]})
            elif self.path == "/blob":
                data = object_bytes
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    origin = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        worker = PredictorRuntime(tmp_path, "owner", "launcher", origin, 1000000)
        grant = {"manifest_url": origin + "/prediction/datasets/dataset-1/revisions/1/manifest",
                 "object_url_template": origin + "/prediction/datasets/dataset-1/revisions/1/objects/{object_id}",
                 "token": "scoped-token", "dataset_id": "dataset-1", "revision": 1, "fingerprint": manifest["fingerprint"],
                 "manifest_sha256": hashlib.sha256(raw).hexdigest()}
        prepared = prepare_saved(worker, dataset={"grant": grant}, direction="forward", definition=definition(manifest),
                        model={"modelId": "remote", "revision": 1, "operationId": "operation", "name": "Remote data"})
        result = call(worker, "model.predict", instance=prepared["instance"], input={"direction": "forward", "vars": {"x": .5}})
        assert result["output"][0]["values"] == pytest.approx([15])
        assert worker.store.list("datasets") == []
        assert list((worker.store.namespace / ".transfers").iterdir()) == []
        assert requested[-1] == ("/blob", None)
        assert all(token == "Bearer scoped-token" for path, token in requested if path != "/blob")
        with pytest.raises(PredictionError, match="trusted API"):
            worker.reader._api_request("http://other.invalid/prediction/datasets/1/manifest", "secret")
        with pytest.raises(PredictionError, match="checksum"):
            worker.reader.load({"grant": {**grant, "manifest_sha256": "0" * 64}})
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_output_selection_ignores_calculation_contracts(tmp_path):
    worker = runtime(tmp_path)
    manifest = dataset()
    extra = {**manifest["records"][0], "id": 11, "name": "heat.other"}
    manifest["records"].append(extra)
    # A broken Calculation is unrelated to Forward input preparation.
    manifest["calculations"][0]["output_layout"] = None
    manifest["calculationData"][0]["data"] = {"shape": [10 ** 12]}
    reference = stage(worker, manifest)
    model_definition = {**definition(manifest), "requiredRecordIds": [10]}
    prepared = prepare_saved(worker, dataset=reference, direction="forward", definition=model_definition,
                    model={"modelId": "selected", "revision": 1, "operationId": "operation", "name": "Selected"})
    assert [item["recordId"] for item in prepared["recordProfiles"]] == [10]
    result = call(worker, "model.predict", instance=prepared["instance"], input={"direction": "forward", "vars": {"x": .5}})
    assert [item["layout"]["key"] for item in result["output"]] == ["heat.T"]
    assert result["output"][0]["values"] == pytest.approx([15])


def test_retired_inverse_requests_do_not_create_or_run_models(tmp_path):
    worker = runtime(tmp_path)
    hello = call(worker, "predictor.hello")
    assert hello["capabilities"]["directions"] == ["forward"]
    assert hello["capabilities"]["representations"] == ["box-relative-v2"]
    with pytest.raises(PredictionError, match="retired") as error:
        prepare(worker, "inverse")
    assert error.value.code == "unsupported-model"
    assert call(worker, "model.list")["models"] == []
    forward = prepare(worker)
    with pytest.raises(PredictionError, match="Forward Vars"):
        call(worker, "model.predict", instance=forward["instance"], input={"direction": "inverse", "targets": {}})


@pytest.mark.parametrize("change", ["components", "unit", "shape", "time", "frequency"])
def test_unsupported_boxgrid_differences_report_excluded_cohort(tmp_path, change):
    manifest = dataset()
    row = copy.deepcopy(manifest["recorded"][2])
    manifest["recorded"][2] = row
    if change == "components":
        row["data"]["boxGrid"]["components"] = ["other"]
        row["data"]["axes"][6]["ticks"] = ["other"]
    elif change == "unit":
        row["data_schema"]["unit"] = "Cel"
    elif change == "shape":
        row["data"]["shape"][0] = 2
        row["data"]["boxGrid"]["gridShape"][0] = 2
        row["data"]["axes"][0]["ticks"] = [0, 1]
        row["data"]["storage"]["value"] *= 2
    else:
        row["data"]["axes"][3 if change == "time" else 4]["ticks"] = [1]
    prepared = prepare(runtime(tmp_path), manifest=manifest)
    assert prepared["profile"]["includedMeasurementIds"] == [1, 2]
    assert prepared["profile"]["excluded"]["layout-mismatch"] == 1
    assert prepared["profile"]["diagnostics"][0]["reason"] == "layout-mismatch"
