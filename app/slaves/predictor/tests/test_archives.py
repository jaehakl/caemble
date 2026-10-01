from __future__ import annotations

import shutil
import stat
import threading
import zipfile

import pytest

from predictor.archives import CHUNK_BYTES, create_archive, unpack_archive
from predictor.errors import PredictionError
from predictor.runtime import PredictorRuntime
from predictor.storage import encode_json
from .fixtures import dataset, stage
from .test_prediction import call, prepare, runtime
from .transfer_fixture import TransferServer
from predictor.transfers import OperationTransfer


def test_portable_archive_preserves_bytes_and_restored_dataset_revision(tmp_path):
    source = runtime(tmp_path / "source")
    prepared = prepare(source)
    call(source, "model.release", instance=prepared["instance"])
    model = create_archive(source.store, "model", "model-forward", 1, tmp_path / "model.zip")
    create_archive(source.store, "model", "model-forward", 1, tmp_path / "again.zip")
    assert (tmp_path / "model.zip").read_bytes() == (tmp_path / "again.zip").read_bytes()
    data = create_archive(source.store, "dataset", "dataset-1", 1, tmp_path / "dataset.zip")
    target = runtime(tmp_path / "target")
    assert target.store.storage_id != source.store.storage_id
    for kind, artifact in (("model", model), ("dataset", data)):
        staging = target.store.namespace / f"pending-{kind}"
        unpack_archive(tmp_path / f"{kind}.zip", staging, kind, artifact["identity"], 1, artifact["manifest_sha256"])
        target.store.publish_replica(kind + "s", artifact["identity"], 1, staging, artifact["manifest_sha256"])
    shutil.rmtree(source.store.root)
    loaded = call(target, "model.load", modelId="model-forward", revision=1)
    result = call(target, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})
    assert result["output"][0]["values"] == pytest.approx([15], rel=1e-12, abs=1e-12)
    assert loaded["artifact"]["manifestChecksum"] == prepared["artifact"]["manifestChecksum"]
    assert result["provenance"] == {"modelId": "model-forward", "modelRevision": 1, "datasetId": "dataset-1", "datasetRevision": 1}
    updated = dataset()
    updated.update(revision=2, fingerprint="sha256:" + "a" * 64)
    stage(target, updated)
    assert target.store.latest_dataset("dataset-1") == 2
    assert target.reader.load({"datasetId": "dataset-1", "revision": 1, "fingerprint": dataset()["fingerprint"]})["revision"] == 1
    assert sorted(item["revision"] for item in target.store.list("datasets")) == [1, 2]
    target.store.remove_replica("datasets", "dataset-1", 1)
    staging = target.store.namespace / "restaged"
    unpack_archive(tmp_path / "dataset.zip", staging, "dataset", "dataset-1", 1, data["manifest_sha256"])
    target.store.publish_replica("datasets", "dataset-1", 1, staging, data["manifest_sha256"])
    assert target.store.latest_dataset("dataset-1") == 2


@pytest.mark.parametrize("attack", ["traversal", "absolute", "drive", "backslash", "duplicate", "symlink", "compressed", "checksum"])
def test_restore_rejects_malicious_archives_without_publishing(tmp_path, attack):
    worker = runtime(tmp_path / "source")
    prepare(worker)
    artifact = create_archive(worker.store, "model", "model-forward", 1, tmp_path / "good.zip")
    with zipfile.ZipFile(tmp_path / "good.zip") as source, zipfile.ZipFile(tmp_path / "bad.zip", "w") as target:
        for entry in source.infolist():
            raw = source.read(entry)
            if attack == "checksum" and entry.filename == "model.json":
                raw = raw.replace(b"forward", b"inverse")
            target.writestr(entry, raw)
        if attack != "checksum":
            name = {"traversal": "../escape", "absolute": "/escape", "drive": "C:escape", "backslash": "..\\escape",
                    "duplicate": "MODEL.JSON", "symlink": "link", "compressed": "compressed"}[attack]
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16 if attack == "symlink" else (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED if attack == "compressed" else zipfile.ZIP_STORED
            target.writestr(info, b"outside")
    with pytest.raises(PredictionError):
        unpack_archive(tmp_path / "bad.zip", tmp_path / "staging", "model", "model-forward", 1, artifact["manifest_sha256"])
    assert not (tmp_path / "escape").exists()


def test_copy_lease_blocks_removal_and_checksum_conflict_does_not_overwrite(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    call(worker, "model.release", instance=prepared["instance"])
    with worker.store.read_lease("models", "model-forward", 1):
        with pytest.raises(PredictionError, match="Release"):
            worker.store.remove_replica("models", "model-forward", 1)
    with pytest.raises(PredictionError, match="different content"):
        worker.store.publish_replica("models", "model-forward", 1, tmp_path / "unused", "0" * 64)
    assert worker.store.read("models", "model-forward", 1)[2] == prepared["artifact"]["manifestChecksum"]
    worker.store.remove_replica("models", "model-forward", 1)
    assert not worker.store.deleted("model-forward", 1)


def test_direct_backup_restore_and_lost_registration_without_source(tmp_path):
    with TransferServer() as server:
        source = PredictorRuntime(tmp_path / "source", "owner", "launcher-a", server.url, 128 * 1024 * 1024)
        prepared = prepare(source)
        call(source, "model.release", instance=prepared["instance"])
        metadata = dataset()
        operation = {"id": "backup", "kind": "backup", "model_id": "model-forward", "model_revision": 1,
                     "include_dataset": True, "dataset_id": "dataset-1", "dataset_revision": 1,
                     "dataset_fingerprint": metadata["fingerprint"]}
        server.operations["backup"] = operation
        body = {"operationId": "backup", "grant": server.grant("backup"), "includeDataset": True,
                "model": {"modelId": "model-forward", "revision": 1, "manifestChecksum": prepared["artifact"]["manifestChecksum"]}}
        server.fail_registration = True
        with pytest.raises(PredictionError, match="HTTP 503"):
            call(source, "artifact.backup", **body)
        assert source.store.receipt("backup")["state"] == "interrupted"
        assert source.store.receipt("backup")["registrationReady"]
        source.store.remove_replica("models", "model-forward", 1)
        source.store.remove_replica("datasets", "dataset-1", 1)
        server.fail_registration = False
        response = call(source, "artifact.backup", **body)
        assert response["receipt"]["state"] == "complete"
        assert "scoped-test-token" not in encode_json(source.store.receipt("backup")).decode()
        target = PredictorRuntime(tmp_path / "target", "owner", "launcher-b", server.url, 128 * 1024 * 1024)
        server.operations["restore"] = {**operation, "id": "restore", "kind": "restore", "target_storage_id": target.store.storage_id}
        server.fail_registration = True
        with pytest.raises(PredictionError, match="HTTP 503"):
            call(target, "artifact.restore", operationId="restore", grant=server.grant("restore"))
        assert target.store.path("models", "model-forward", 1).exists()
        server.fail_registration = False
        restored = call(target, "artifact.restore", operationId="restore", grant=server.grant("restore"))
        assert restored["receipt"]["state"] == "complete"
        fresh = PredictorRuntime(tmp_path / "target", "owner", "launcher-c", server.url, 128 * 1024 * 1024)
        loaded = call(fresh, "model.load", modelId="model-forward", revision=1)
        assert loaded["artifact"]["manifestChecksum"] == prepared["artifact"]["manifestChecksum"]
        result = call(fresh, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})
        assert result["output"][0]["values"] == pytest.approx([15], rel=1e-12, abs=1e-12)
        assert len(fresh.store.list("models")) == 1


def test_standalone_dataset_restore_is_retained_and_reuses_exact_revision(tmp_path):
    with TransferServer() as server:
        source = runtime(tmp_path / "source")
        stage(source)
        archive = create_archive(source.store, "dataset", "dataset-1", 1, tmp_path / "dataset.zip")
        server.operations["backup"] = {"id": "backup", "kind": "backup"}
        transfer = OperationTransfer(server.url, server.grant("backup"))
        transfer.upload("dataset", tmp_path / "dataset.zip", archive)
        target = PredictorRuntime(tmp_path / "target", "owner", "launcher", server.url, 128 * 1024 * 1024)
        server.operations["restore-data"] = {"id": "restore-data", "kind": "restore", "asset_kind": "dataset",
            "include_dataset": False, "target_storage_id": target.store.storage_id,
            "dataset_id": "dataset-1", "dataset_revision": 1, "dataset_fingerprint": dataset()["fingerprint"]}
        result = call(target, "artifact.restore", operationId="restore-data", grant=server.grant("restore-data"))
        assert set(result["receipt"]["artifacts"]) == {"dataset"}
        assert target.store.list("models") == []
        assert target.reader.load({"datasetId": "dataset-1", "revision": 1, "fingerprint": dataset()["fingerprint"]})["measurements"] == dataset()["measurements"]


def test_cancelled_restore_and_unavailable_dataset_never_publish_partial_files(tmp_path):
    with TransferServer() as server:
        source = PredictorRuntime(tmp_path / "source", "owner", "launcher", server.url, 128 * 1024 * 1024)
        prepared = prepare(source)
        source.store.remove_replica("datasets", "dataset-1", 1)
        server.operations["backup"] = {"id": "backup", "kind": "backup", "model_id": "model-forward", "model_revision": 1,
            "include_dataset": True, "dataset_id": "dataset-1", "dataset_revision": 1, "dataset_fingerprint": dataset()["fingerprint"]}
        with pytest.raises(PredictionError, match="exact Dataset"):
            call(source, "artifact.backup", operationId="backup", grant=server.grant("backup"), includeDataset=True,
                 model={"modelId": "model-forward", "revision": 1, "manifestChecksum": prepared["artifact"]["manifestChecksum"]})
        assert server.put_count == 0
        cancellation = threading.Event()
        cancellation.set()
        with pytest.raises(PredictionError, match="cancelled"):
            source.dispatch("artifact.backup", {"protocolVersion": 2, "requestId": "cancel", "sessionId": source.session_id,
                "operationId": "backup", "grant": server.grant("backup")}, cancellation)
        result = call(source, "model.predict", instance=prepared["instance"], input={"direction": "forward", "vars": {"x": .5}})
        assert result["output"][0]["values"] == pytest.approx([15])


def test_scoped_grants_reject_other_origins_and_operation_paths():
    grant = {"operation_id": "one", "token": "secret", "manifest_url": "https://other.example/prediction/operations/one/transfer"}
    with pytest.raises(PredictionError, match="trusted API"):
        OperationTransfer("https://trusted.example", grant).describe()
    grant["manifest_url"] = "https://trusted.example/prediction/operations/two/transfer"
    with pytest.raises(PredictionError, match="trusted API"):
        OperationTransfer("https://trusted.example", grant).describe()


def test_scoped_removal_allows_corrupt_copy_but_rejects_lease_and_identity_mismatch(tmp_path):
    with TransferServer() as server:
        worker = PredictorRuntime(tmp_path, "owner", "launcher", server.url, 128 * 1024 * 1024)
        prepared = prepare(worker)
        server.operations["remove"] = {"id": "remove", "kind": "delete_replica", "asset_kind": "model", "asset_id": "model-forward",
            "replicas": [{"id": "replica", "storage_id": worker.store.storage_id, "revision": 1,
                          "manifest_sha256": prepared["artifact"]["manifestChecksum"], "blocked": True}]}
        body = {"operationId": "remove", "grant": server.grant("remove"), "replicaId": "replica", "kind": "model",
                "identity": "model-forward", "revision": 1}
        with pytest.raises(PredictionError, match="being used"):
            call(worker, "artifact.remove", **body)
        server.operations["remove"]["replicas"][0]["blocked"] = False
        with pytest.raises(PredictionError, match="Release"):
            call(worker, "artifact.remove", **body)
        call(worker, "model.release", instance=prepared["instance"])
        path = worker.store.path("models", "model-forward", 1)
        (path / "manifest.json").write_bytes(b"damaged")
        with pytest.raises(PredictionError, match="authorized storage"):
            call(worker, "artifact.remove", **{**body, "identity": "another-model"})
        assert path.exists()
        result = call(worker, "artifact.remove", **body)
        assert result["receipt"]["state"] == "complete"
        assert not path.exists()
        assert not worker.store.deleted("model-forward", 1)
        assert call(worker, "artifact.remove", **body)["receipt"]["state"] == "complete"


def test_expired_signed_urls_refresh_only_the_current_chunk_and_preserve_bytes(tmp_path):
    with TransferServer() as server:
        server.rotate_tickets = True
        server.expire_parts = {("PUT", 1), ("GET", 1)}
        server.operations["backup"] = {"id": "backup", "kind": "backup"}
        source = tmp_path / "source.zip"
        source.write_bytes(b"x" * CHUNK_BYTES + b"second chunk")
        artifact = {"manifest_sha256": "a" * 64, "files": [], "format_version": 1}
        OperationTransfer(server.url, server.grant("backup")).upload("model", source, artifact)
        assert server.put_count == 2
        uploads = [entry for entry in server.part_requests if entry[0] == "PUT"]
        assert [entry[1] for entry in uploads] == [0, 1, 1]
        assert uploads[1][2] != uploads[2][2]
        server.operations["restore"] = {"id": "restore", "kind": "restore"}
        target = tmp_path / "restored.zip"
        OperationTransfer(server.url, server.grant("restore")).download("model", target)
        assert target.read_bytes() == source.read_bytes()
        downloads = [entry for entry in server.part_requests if entry[0] == "GET"]
        assert [entry[1] for entry in downloads] == [0, 1, 1]
        assert downloads[1][2] != downloads[2][2]


def test_expired_download_ticket_cannot_switch_immutable_object(tmp_path):
    with TransferServer() as server:
        server.rotate_tickets = True
        server.operations["backup"] = {"id": "backup", "kind": "backup"}
        source = tmp_path / "source.zip"
        source.write_bytes(b"immutable archive")
        artifact = {"manifest_sha256": "a" * 64, "files": [], "format_version": 1}
        OperationTransfer(server.url, server.grant("backup")).upload("model", source, artifact)
        server.operations["restore"] = {"id": "restore", "kind": "restore"}
        transfer = OperationTransfer(server.url, server.grant("restore"))
        pinned = transfer.describe()["model"]
        server.expire_parts = {("GET", 0)}
        server.archives["model"]["reference"]["id"] = "another-object"
        target = tmp_path / "rejected.zip"
        with pytest.raises(PredictionError, match="immutable content"):
            transfer.download("model", target, pinned)
        assert target.read_bytes() == b""
