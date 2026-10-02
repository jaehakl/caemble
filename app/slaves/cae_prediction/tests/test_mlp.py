"""Numerical holdout, inert portability and allocated-device MLP lifecycle checks."""
from __future__ import annotations

import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading

import numpy as np
import pytest

from prediction_contracts import MLP_DEFAULT_ALGORITHM, QUALITY_VALIDATION_V1
from sdk.protocol.execution import ResourceAllocation
from predictor.archives import create_archive, unpack_archive, validate_content
from predictor.errors import PredictionError
from predictor.execution import ModelExecutionContext
from predictor.mlp import TorchMlpForwardModel
from predictor.models import ModelBundle
from predictor.quality import evaluate_quality, split_dataset
from predictor.storage import ArtifactStore, encode_json
from .fixtures import dataset


REF = {"modelId": "mlp-model", "revision": 1, "operationId": "mlp-training", "name": "MLP"}
CONTEXT = ModelExecutionContext(None, 512 * 1024**2)


def mlp_definition(manifest, **settings):
    return {"direction": "forward", "fingerprint": "mlp-fingerprint", "snapshotFingerprint": manifest["fingerprint"],
            "implementationVersion": "mlp-v1", "preprocessingVersion": "box-relative-v2", "requiredRecordIds": [10],
            "algorithm": {**copy.deepcopy(MLP_DEFAULT_ALGORITHM), **settings}}


def numerical_dataset():
    result = dataset()
    base = result["recorded"][0]
    result["varsSchema"] = {"y": {"shape": [], "min": -1, "max": 1}, "x": {"shape": [], "min": -1, "max": 1}}
    result["measurements"], result["recorded"], result["calculationData"] = [], [], []
    for identity, (x, y) in enumerate(((x, y) for x in np.linspace(-1, 1, 9) for y in np.linspace(-1, 1, 9)), 1):
        result["measurements"].append({"id": identity, "vars": {"x": float(x), "y": float(y)}})
        row = copy.deepcopy(base)
        row.update(id=100 + identity, measurement_id=identity)
        row["data"]["shape"][-1] = 3
        for grid in (row["data"]["boxGrid"], row["data_schema"]["boxGrid"]):
            grid["components"] = ["linear", "smooth", "constant"]
        for axis in (row["data"]["axes"][-1], row["data_schema"]["axes"][-1]):
            axis["ticks"] = ["linear", "smooth", "constant"]
        row["data"]["storage"]["value"] = [[[[[[[float(2*x-y), float(x*x + .5*y), 1.2345678901234567]]]]]]]
        result["recorded"].append(row)
    result["rules"][0]["result"] = copy.deepcopy(result["recorded"][0]["data_schema"])
    result.pop("fingerprint")
    result["fingerprint"] = "sha256:" + hashlib.sha256(encode_json(result)).hexdigest()
    return result


@pytest.fixture(scope="module", autouse=True)
def torch_threads():
    import torch
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous)


@pytest.fixture
def trained():
    manifest = numerical_dataset()
    training, groups, split = split_dataset(manifest)
    definition = {**mlp_definition(manifest), "qualityValidation": copy.deepcopy(QUALITY_VALIDATION_V1)}
    bundle = ModelBundle.prepare(training, "forward", definition, REF, CONTEXT)
    bundle.metadata["qualityReport"] = evaluate_quality(bundle, manifest, groups, split, lambda: CONTEXT)
    yield manifest, training, groups, split, bundle
    bundle.close()


def test_default_holdout_accuracy_and_training_only_normalization(trained):
    manifest, training, groups, split, bundle = trained
    report = evaluate_quality(bundle, manifest, groups, split, lambda: CONTEXT)
    assert report["status"] == "complete"
    components = report["records"][0]["components"]
    train_values = np.array([row["data"]["storage"]["value"][0][0][0][0][0][0] for row in training["recorded"]])
    holdout_ids = set(split["validationMeasurementIds"])
    heldout = np.array([row["data"]["storage"]["value"][0][0][0][0][0][0] for row in manifest["recorded"] if row["measurement_id"] in holdout_ids])
    all_values = np.array([row["data"]["storage"]["value"][0][0][0][0][0][0] for row in manifest["recorded"]])
    baseline = np.abs(heldout - train_values.mean(axis=0)).mean(axis=0)
    for index, component in enumerate(components[:2]):
        assert component["mae"] < np.ptp(all_values[:, index]) * .05
        assert component["mae"] < baseline[index] * .5
    assert components[2]["mae"] == 0
    assert bundle.profile()["includedMeasurementIds"] == split["trainingMeasurementIds"]
    assert bundle.implementation.arrays["outputCenter"][:2] == pytest.approx(train_values.mean(axis=0)[:2])
    assert [layout["key"] for layout in bundle.implementation.input_layouts] == ["x", "y"]


def test_save_fresh_process_load_batch_and_archive_without_dataset(trained, tmp_path):
    _, _, _, _, bundle = trained
    store = ArtifactStore(tmp_path / "store", "owner", "launcher")
    artifact = bundle.save(store)
    reference = bundle.predict({"direction": "forward", "vars": {"x": .2, "y": .4}}, CONTEXT)
    script = """
import json, sys
from pathlib import Path
from app.execution import ModelExecutionContext
from app.models import ModelBundle
from app.storage import ArtifactStore
context = ModelExecutionContext(None, 512*1024**2)
store = ArtifactStore(Path(sys.argv[1]), 'owner', 'launcher')
bundle, artifact = ModelBundle.load(store, 'mlp-model', 1, context)
print(json.dumps(bundle.predict({'direction': 'forward', 'vars': {'x': .2, 'y': .4}}, context)))
bundle.close()
"""
    result = subprocess.run([sys.executable, "-c", script, str(store.root)], cwd=Path(__file__).resolve().parents[1],
                            capture_output=True, text=True, encoding="utf-8", check=True)
    assert json.loads(result.stdout)["output"] == reference["output"]
    loaded, _ = ModelBundle.load(store, "mlp-model", 1, CONTEXT)
    try:
        queries = [{"direction": "forward", "vars": {"x": value, "y": .4}} for value in (.2, -.8, 2)]
        batch = loaded.predict_many(queries, CONTEXT)
        for query, actual in zip(queries, batch):
            assert actual["output"][0]["values"] == pytest.approx(loaded.predict(query, CONTEXT)["output"][0]["values"], abs=1e-6)
        assert batch[-1]["extrapolatedInputKeys"] == ["x"]
    finally:
        loaded.close()
        loaded.close()
    archive = tmp_path / "model.zip"
    create_archive(store, "model", "mlp-model", 1, archive)
    unpack_archive(archive, tmp_path / "restored", "model", "mlp-model", 1, artifact["manifestChecksum"])
    restored = json.loads((tmp_path / "restored" / "model.json").read_bytes())
    assert restored["numerical"]["cohort"]["includedMeasurementIds"] == bundle.profile()["includedMeasurementIds"]


def test_common_cohort_excludes_missing_or_incompatible_records():
    manifest = numerical_dataset()
    second = {"id": 11, "name": "heat.other", "contract_hash": "other"}
    manifest["records"].append(second)
    manifest["rules"].append({**copy.deepcopy(manifest["rules"][0]), "label": second["name"]})
    for original in list(manifest["recorded"]):
        if original["measurement_id"] == 1:
            continue
        row = copy.deepcopy(original)
        row.update(id=row["id"] + 1000, name=second["name"], experiment_record_id=11)
        if row["measurement_id"] == 2:
            row["data_schema"]["unit"] = "Pa"
        manifest["recorded"].append(row)
    definition = {**mlp_definition(manifest, epochs=1), "requiredRecordIds": [10, 11]}
    bundle = ModelBundle.prepare(manifest, "forward", definition, REF, CONTEXT)
    try:
        assert bundle.profile()["includedMeasurementIds"] == list(range(3, 82))
        assert bundle.profile()["excluded"]["missing-block"] == 1
        assert bundle.profile()["excluded"]["layout-mismatch"] == 1
        profiles = bundle.implementation.preparation_details()["recordProfiles"]
        assert profiles[0]["profile"]["includedMeasurementIds"] == profiles[1]["profile"]["includedMeasurementIds"]
    finally:
        bundle.close()


@pytest.mark.parametrize("kind", ["complex", "modal"])
def test_unsupported_output_fails_explicitly(kind):
    manifest = numerical_dataset()
    grid = manifest["rules"][0]["result"]["boxGrid"]
    if kind == "complex":
        grid["channels"] = ["amplitude", "phase"]
    else:
        grid["frequencyKind"] = "modal"
    with pytest.raises(PredictionError) as rejected:
        ModelBundle.prepare(manifest, "forward", mlp_definition(manifest), REF, CONTEXT)
    assert rejected.value.code == "unsupported-representation"


@pytest.mark.parametrize("damage", ["shape", "dtype", "nonfinite", "negative-scale", "normalization", "inventory", "checksum"])
def test_corrupt_artifact_is_rejected_without_constructing_network(trained, tmp_path, monkeypatch, damage):
    bundle = trained[-1]
    store = ArtifactStore(tmp_path, "owner", "launcher")
    bundle.save(store)
    manifest, path, _ = store.read("models", "mlp-model", 1)
    content = json.loads((path / "model.json").read_bytes())
    if damage == "inventory":
        manifest["files"] = manifest["files"][:-1]
    else:
        name = "outputScale" if damage == "negative-scale" else "inputMinimums" if damage == "normalization" else "weight-0"
        values = np.load(path / f"{name}.npy", allow_pickle=False)
        if damage == "shape":
            values = values.reshape(-1)
        elif damage == "dtype":
            values = values.astype(np.float64)
        else:
            values.flat[0] = -1 if damage == "negative-scale" else 20 if damage in ("normalization", "checksum") else np.nan
        np.save(path / f"{name}.npy", values, allow_pickle=False)
    monkeypatch.setattr("predictor.mlp.make_network", lambda *_: pytest.fail("Corrupt artifact constructed a model"))
    with pytest.raises(PredictionError) as rejected:
        if damage == "checksum":
            ModelBundle.load(store, "mlp-model", 1, CONTEXT)
        else:
            validate_content(path, manifest, "model")
    assert rejected.value.code == "artifact-checksum"


def test_cancel_between_minibatches_cleans_up_and_allows_retry(monkeypatch):
    import torch
    manifest, cancel = numerical_dataset(), threading.Event()
    step, calls = torch.optim.Adam.step, []
    def cancel_step(optimizer, *args, **kwargs):
        result = step(optimizer, *args, **kwargs)
        calls.append(1)
        cancel.set()
        return result
    monkeypatch.setattr(torch.optim.Adam, "step", cancel_step)
    with pytest.raises(PredictionError) as stopped:
        ModelBundle.prepare(manifest, "forward", mlp_definition(manifest), REF, replace(CONTEXT, cancel=cancel))
    assert stopped.value.code == "cancelled" and len(calls) == 1
    monkeypatch.setattr(torch.optim.Adam, "step", step)
    bundle = ModelBundle.prepare(manifest, "forward", mlp_definition(manifest, epochs=1), REF, CONTEXT)
    bundle.close()
    assert bundle.persistent_bytes == 0


def test_constant_only_outputs_skip_optimizer_and_restore_exactly(monkeypatch):
    import torch
    manifest = numerical_dataset()
    for row in manifest["recorded"]:
        row["data"]["storage"]["value"] = [[[[[[[1.2345678901234567, -2.0, 0.0]]]]]]]
    monkeypatch.setattr(torch.optim, "Adam", lambda *_args, **_kwargs: pytest.fail("Constant-only model created an optimizer"))
    model = ModelBundle.prepare(manifest, "forward", mlp_definition(manifest), REF, CONTEXT)
    try:
        result = model.predict({"direction": "forward", "vars": {"x": .25, "y": .33}}, CONTEXT)
        assert result["output"][0]["values"] == [1.2345678901234567, -2.0, 0.0]
        assert model.profile()["mlp"]["loss"] == 0
    finally:
        model.close()


def test_constant_cells_never_contribute_to_training_gradients():
    import torch
    from predictor.mlp import make_network
    manifest = numerical_dataset()
    with torch.random.fork_rng(devices=[]):
        torch.random.default_generator.manual_seed(0)
        initial = make_network(torch, [2, 32, 32, 3])[-1].weight.detach().numpy().copy()
    model = ModelBundle.prepare(manifest, "forward", mlp_definition(manifest, epochs=1), REF, CONTEXT)
    try:
        final = model.implementation.arrays["weight-2"]
        assert np.array_equal(initial[2], final[2])
        assert not np.array_equal(initial[:2], final[:2])
    finally:
        model.close()


def test_ram_and_vram_preflight_reject_before_network_allocation(monkeypatch):
    manifest = numerical_dataset()
    monkeypatch.setattr("predictor.mlp.make_network", lambda *_: pytest.fail("Budget failure constructed a network"))
    allocation = ResourceAllocation(cpu_ids=[0], cpu_cores=1, startup_ram_bytes=1024**3, ram_available_bytes=1024**3,
                                    gpu_devices=["GPU-fixture"], vram_budget_bytes={"GPU-fixture": 1024})
    for context in (replace(CONTEXT, available_ram_bytes=1), replace(CONTEXT, allocation=allocation)):
        with pytest.raises(PredictionError) as rejected:
            ModelBundle.prepare(manifest, "forward", mlp_definition(manifest), REF, context)
        assert rejected.value.code == "memory-limit"


def test_allocated_gpu_unavailable_never_falls_back_to_cpu(monkeypatch):
    import torch
    manifest = numerical_dataset()
    allocation = ResourceAllocation(cpu_ids=[0], cpu_cores=1, startup_ram_bytes=1024**3, ram_available_bytes=1024**3,
                                    gpu_devices=["GPU-fixture"], vram_budget_bytes={"GPU-fixture": 1024**3})
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(PredictionError) as rejected:
        ModelBundle.prepare(manifest, "forward", mlp_definition(manifest), REF, replace(CONTEXT, allocation=allocation))
    assert rejected.value.code == "resource-allocation"


def test_cpu_cuda_artifact_portability_and_device_release(trained, tmp_path):
    import torch
    if not torch.cuda.is_available():
        pytest.skip("CUDA device is unavailable")
    properties = torch.cuda.get_device_properties(0)
    identity = str(properties.uuid)
    allocation = ResourceAllocation(cpu_ids=[0], cpu_cores=1, startup_ram_bytes=1024**3, ram_available_bytes=1024**3,
                                    gpu_devices=[identity], vram_budget_bytes={identity: properties.total_memory})
    context = replace(CONTEXT, allocation=allocation)
    store = ArtifactStore(tmp_path, "owner", "launcher")
    trained[-1].save(store)
    baseline = torch.cuda.memory_allocated(0)
    loaded, _ = ModelBundle.load(store, "mlp-model", 1, context)
    query = {"direction": "forward", "vars": {"x": .2, "y": .4}}
    assert loaded.implementation.device.type == "cuda"
    assert loaded.predict(query, context)["output"][0]["values"] == pytest.approx(trained[-1].predict(query, CONTEXT)["output"][0]["values"], abs=1e-6)
    loaded.close()
    loaded.close()
    assert torch.cuda.memory_allocated(0) == baseline
    trained_gpu = ModelBundle.prepare(trained[1], "forward", mlp_definition(trained[0]), {**REF, "revision": 2}, context)
    gpu_values = trained_gpu.predict(query, context)["output"][0]["values"]
    trained_gpu.save(store)
    trained_gpu.close()
    assert torch.cuda.memory_allocated(0) == baseline
    loaded_cpu, _ = ModelBundle.load(store, "mlp-model", 2, CONTEXT)
    assert loaded_cpu.predict(query, CONTEXT)["output"][0]["values"] == pytest.approx(gpu_values, abs=1e-6)
    loaded_cpu.close()


def test_cuda_cancel_releases_partial_training_and_leaves_saved_model_usable(trained, tmp_path):
    import torch
    if not torch.cuda.is_available():
        pytest.skip("CUDA device is unavailable")
    properties = torch.cuda.get_device_properties(0)
    identity, cancel = str(properties.uuid), threading.Event()
    allocation = ResourceAllocation(cpu_ids=[0], cpu_cores=1, startup_ram_bytes=1024**3, ram_available_bytes=1024**3,
                                    gpu_devices=[identity], vram_budget_bytes={identity: properties.total_memory})
    context = replace(CONTEXT, allocation=allocation, cancel=cancel, progress=lambda _: cancel.set())
    store = ArtifactStore(tmp_path, "owner", "launcher")
    previous = trained[-1].save(store)
    baseline = torch.cuda.memory_allocated(0)
    with pytest.raises(PredictionError) as stopped:
        ModelBundle.prepare(trained[1], "forward", mlp_definition(trained[0]), {**REF, "revision": 2}, context)
    assert stopped.value.code == "cancelled"
    assert torch.cuda.memory_allocated(0) == baseline
    assert not store.path("models", "mlp-model", 2).exists()
    loaded, artifact = ModelBundle.load(store, "mlp-model", 1, CONTEXT)
    assert artifact["manifestChecksum"] == previous["manifestChecksum"]
    assert loaded.predict({"direction": "forward", "vars": {"x": 0, "y": 0}}, CONTEXT)["output"]
    loaded.close()


def test_importing_registry_does_not_import_torch():
    script = "import sys; import app.models; assert 'torch' not in sys.modules"
    subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
