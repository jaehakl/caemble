"""Durable storage operations, independent from prediction handles and panel lifetime."""
from __future__ import annotations

from contextlib import ExitStack
import os
from pathlib import Path
import tempfile

import psutil

from .archives import create_archive, unpack_archive
from .dataset import DatasetReader
from .errors import PredictionError
from .storage import ArtifactStore, check_cancel, safe_id
from .transfers import OperationTransfer


class ArtifactOperations:
    def __init__(self, store: ArtifactStore, api_url: str, memory_budget: int):
        self.store, self.api_url, self.memory_budget = store, api_url, memory_budget

    def verify(self, payload: dict, cancel=None) -> dict:
        kind, identity, revision = payload["kind"], payload["identity"], payload["revision"]
        if kind not in ("model", "dataset"):
            raise PredictionError("invalid-reference", "Unknown artifact category.")
        result = {"storageId": self.store.storage_id, "launcherId": self.store.launcher_id}
        try:
            with self.store.read_lease(kind + "s", identity, revision, cancel):
                manifest, _, checksum = self.store.read(kind + "s", identity, revision, cancel=cancel)
                if payload.get("manifestChecksum") and checksum != payload["manifestChecksum"]:
                    raise PredictionError("artifact-checksum", "Artifact differs from its registered checksum.")
                return {**result, "state": "present", "artifact": {"manifest_sha256": checksum,
                        "format_version": 1, "files": manifest["files"]}}
        except PredictionError as error:
            if error.code not in ("artifact-missing", "artifact-checksum", "artifact-version"):
                raise
            return {**result, "state": "missing" if error.code == "artifact-missing" else "corrupt",
                    "error": {"code": error.code, "message": str(error)}}

    def run(self, action: str, payload: dict, cancel=None) -> dict:
        if action == "artifact.verify":
            return self.verify(payload, cancel)
        operation_id = safe_id(payload["operationId"])
        if action == "operation.inspect":
            receipt = self.store.receipt(operation_id)
            if receipt and payload.get("grant") and receipt.get("registrationReady"):
                if payload["grant"].get("operation_id") != operation_id:
                    raise PredictionError("operation-conflict", "Grant belongs to another operation.")
                transfer = OperationTransfer(self.api_url, payload["grant"], cancel)
                with self.store.transaction(cancel, operation_id=operation_id):
                    transfer.describe()
                    body = ({} if receipt["kind"] == "backup" else {"replica_id": receipt["removedReplicaId"]}
                            if receipt["kind"] == "remove" else
                            {kind: {key: artifact[key] for key in ("manifest_sha256", "files", "format_version")}
                             for kind, artifact in receipt["artifacts"].items()})
                    return self._finish(receipt, transfer, body)
            if receipt and receipt["state"] not in ("complete", "uploaded", "cancelled", "interrupted"):
                try:
                    alive = psutil.Process(receipt["workerPid"]).create_time() == receipt["workerCreatedAt"]
                except (psutil.NoSuchProcess, KeyError):
                    alive = False
                if not alive:
                    receipt["state"] = "interrupted"
                    self.store.save_receipt(operation_id, receipt)
            return {"receipt": receipt}
        grant = payload["grant"]
        if grant.get("operation_id") != operation_id:
            raise PredictionError("operation-conflict", "Grant belongs to another operation.")
        transfer = OperationTransfer(self.api_url, grant, cancel)
        with self.store.transaction(cancel, operation_id=operation_id):
            description = transfer.describe()
            operation = description["operation"]
            receipt = self.store.receipt(operation_id)
            expected_kind = {"artifact.backup": "backup", "artifact.restore": "restore", "artifact.remove": "remove"}[action]
            if receipt is not None and receipt["kind"] != expected_kind:
                raise PredictionError("operation-conflict", "Operation ID was already used for another storage action.")
            receipt = receipt or {"operationId": operation_id, "kind": expected_kind, "state": "preparing",
                                  "storageId": self.store.storage_id, "launcherId": self.store.launcher_id, "artifacts": {}}
            process = psutil.Process()
            receipt.update(workerPid=process.pid, workerCreatedAt=process.create_time())
            for child in self.store.path("operations", operation_id).iterdir():
                if child.is_dir() and child.name.startswith(("backup-", "restore-")):
                    self.store._remove(child)
            self.store.save_receipt(operation_id, receipt)
            try:
                if action == "artifact.backup":
                    return self._backup(payload, description, receipt, transfer, cancel)
                if action == "artifact.restore":
                    return self._restore(description, receipt, transfer, cancel)
                return self._remove(payload, operation, receipt, transfer, cancel)
            except BaseException as error:
                receipt["state"] = "cancelled" if isinstance(error, PredictionError) and error.code == "cancelled" else "interrupted"
                receipt["error"] = {"code": error.code if isinstance(error, PredictionError) else "storage-operation-failed",
                                    "message": str(error) if isinstance(error, PredictionError) else "Storage operation was interrupted; retry to reconcile its completed files."}
                self.store.save_receipt(operation_id, receipt)
                raise

    def _finish(self, receipt, transfer, body):
        receipt["state"] = "registration-pending"
        receipt["registrationReady"] = True
        self.store.save_receipt(receipt["operationId"], receipt)
        operation = transfer.request("register_url", "POST", body)
        state = operation.get("state", operation.get("operation", {}).get("state"))
        receipt["state"] = "complete" if state in ("completed", "complete", "succeeded") else "uploaded"
        receipt.pop("error", None)
        self.store.save_receipt(receipt["operationId"], receipt)
        if receipt["state"] == "complete" and receipt["kind"] == "backup":
            archives = self.store.path("operations", receipt["operationId"]) / "archives"
            if archives.exists():
                try:
                    self.store._remove(archives)
                except OSError:
                    pass  # The registered backup is complete; a later inspection can clean its cache.
        return {"receipt": receipt, "operation": operation}

    def _backup(self, payload, description, receipt, transfer, cancel):
        operation = description["operation"]
        model = payload.get("model") or {"modelId": operation["model_id"], "revision": operation["model_revision"]}
        if (operation["kind"] != "backup" or operation["model_id"] != model["modelId"]
                or operation["model_revision"] != model["revision"]
                or bool(operation["include_dataset"]) != bool(payload["includeDataset"])):
            raise PredictionError("operation-conflict", "Backup differs from its authorized model or inclusion scope.")
        slots = payload.get("slots") or (["model", "dataset"] if payload["includeDataset"] else ["model"])
        if (not isinstance(slots, list) or len(slots) != len(set(slots)) or not slots
                or any(slot not in ("model", "dataset") for slot in slots)
                or ("dataset" in slots and not payload["includeDataset"])):
            raise PredictionError("operation-conflict", "Backup archive slots differ from its authorized scope.")
        directory = self.store.path("operations", receipt["operationId"])
        archives = directory / "archives"
        archives.mkdir(exist_ok=True)
        if receipt.get("registrationReady") and all(slot in receipt["artifacts"] for slot in slots):
            return self._finish(receipt, transfer, {})
        if all(slot in receipt["artifacts"] and (archives / f"{slot}.zip").is_file() for slot in slots):
            for slot in slots:
                dataset = ({"dataset_id": operation["dataset_id"], "revision": operation["dataset_revision"],
                            "fingerprint": operation["dataset_fingerprint"]} if slot == "dataset" else None)
                transfer.upload(slot, archives / f"{slot}.zip", receipt["artifacts"][slot], dataset)
            return self._finish(receipt, transfer, {})
        with ExitStack() as leases, tempfile.TemporaryDirectory(prefix="backup-", dir=directory) as temporary:
            working = Path(temporary)
            if "model" in slots:
                if operation.get("source_storage_id") and operation["source_storage_id"] != self.store.storage_id:
                    raise PredictionError("storage-mismatch", "Backup source belongs to another storage.")
                leases.enter_context(self.store.read_lease("models", model["modelId"], model["revision"], cancel))
                manifest, _, checksum = self.store.read("models", model["modelId"], model["revision"], cancel=cancel)
                if checksum != model.get("manifestChecksum"):
                    raise PredictionError("artifact-checksum", "Backup model differs from its registered revision.")
                model_metadata = manifest["metadata"]
                dataset_ref = {"datasetId": model_metadata["datasetId"], "revision": model_metadata["datasetRevision"],
                               "fingerprint": model_metadata["datasetFingerprint"]}
            else:
                dataset_ref = {"datasetId": operation["dataset_id"], "revision": operation["dataset_revision"],
                               "fingerprint": operation["dataset_fingerprint"]}
            source_store = None
            if "dataset" in slots:
                if (operation["dataset_id"] != dataset_ref["datasetId"] or operation["dataset_revision"] != dataset_ref["revision"]
                        or operation["dataset_fingerprint"] != dataset_ref["fingerprint"]):
                    raise PredictionError("operation-conflict", "Backup Dataset differs from the model provenance.")
                source = payload.get("datasetSource") or {}
                local = self.store.path("datasets", dataset_ref["datasetId"], dataset_ref["revision"])
                if source.get("local") or (not source and local.exists()):
                    expected_storage = operation.get("dataset_source_storage_id") or (operation.get("dataset_source") or {}).get("storage_id")
                    if expected_storage and expected_storage != self.store.storage_id:
                        raise PredictionError("storage-mismatch", "Dataset source belongs to another storage.")
                    if source.get("local") and source["local"] != dataset_ref:
                        raise PredictionError("operation-conflict", "Local Dataset source differs from the model provenance.")
                    leases.enter_context(self.store.read_lease("datasets", dataset_ref["datasetId"], dataset_ref["revision"], cancel))
                    source_store = self.store
                else:
                    source_store = ArtifactStore(working / "dataset-source", "transfer", self.store.launcher_id)
                    if source.get("grant"):
                        grant = source["grant"]
                        if any(grant[key] != value for key, value in (("dataset_id", dataset_ref["datasetId"]),
                                ("revision", dataset_ref["revision"]), ("fingerprint", dataset_ref["fingerprint"]))):
                            raise PredictionError("operation-conflict", "Dataset grant differs from the model provenance.")
                        DatasetReader(source_store, self.api_url, self.memory_budget).import_grant(grant, cancel)
                    else:
                        source_transfer = OperationTransfer(self.api_url, source["backup"], cancel) if source.get("backup") else transfer
                        ticket = (source_transfer.describe() if source.get("backup") else description).get("dataset")
                        if ticket is None:
                            raise PredictionError("dataset-unavailable", "The model's exact Dataset payload is unavailable; model-only backup remains possible.")
                        source_transfer.download("dataset", working / "dataset-source.zip", ticket)
                        unpack_archive(working / "dataset-source.zip", source_store.path("datasets", dataset_ref["datasetId"], dataset_ref["revision"]),
                                       "dataset", dataset_ref["datasetId"], dataset_ref["revision"], ticket["artifact"]["manifest_sha256"], cancel,
                                       self.memory_budget)
                dataset_manifest, _, _ = source_store.read("datasets", dataset_ref["datasetId"], dataset_ref["revision"], cancel=cancel)
                if dataset_manifest["metadata"]["fingerprint"] != dataset_ref["fingerprint"]:
                    raise PredictionError("artifact-checksum", "Dataset payload differs from the model's frozen fingerprint.")
                receipt["artifacts"]["dataset"] = create_archive(source_store, "dataset", dataset_ref["datasetId"], dataset_ref["revision"], working / "dataset.zip", cancel)
            if "model" in slots:
                receipt["artifacts"]["model"] = create_archive(self.store, "model", model["modelId"], model["revision"], working / "model.zip", cancel)
            for slot in slots:
                os.replace(working / f"{slot}.zip", archives / f"{slot}.zip")
            receipt["state"] = "transferring"
            self.store.save_receipt(receipt["operationId"], receipt)
            leases.close()
            if source_store is not None:
                transfer.prepare("dataset", archives / "dataset.zip", receipt["artifacts"]["dataset"],
                                 {"dataset_id": dataset_ref["datasetId"], "revision": dataset_ref["revision"], "fingerprint": dataset_ref["fingerprint"]})
            if "model" in slots:
                transfer.upload("model", archives / "model.zip", receipt["artifacts"]["model"])
            if source_store is not None:
                transfer.upload("dataset", archives / "dataset.zip", receipt["artifacts"]["dataset"],
                                {"dataset_id": dataset_ref["datasetId"], "revision": dataset_ref["revision"], "fingerprint": dataset_ref["fingerprint"]})
        return self._finish(receipt, transfer, {})

    def _restore(self, description, receipt, transfer, cancel):
        operation = description["operation"]
        if operation["kind"] != "restore" or operation["target_storage_id"] != self.store.storage_id:
            raise PredictionError("storage-mismatch", "Restore operation targets another storage.")
        directory = self.store.path("operations", receipt["operationId"])
        staged = {}
        with tempfile.TemporaryDirectory(prefix="restore-", dir=directory) as temporary:
            working = Path(temporary)
            kinds = (("dataset",) if operation.get("asset_kind") == "dataset" else
                     ("model", "dataset") if operation["include_dataset"] else ("model",))
            for kind in kinds:
                identity = operation["model_id"] if kind == "model" else operation["dataset_id"]
                revision = operation["model_revision"] if kind == "model" else operation["dataset_revision"]
                ticket = description.get(kind)
                if ticket is None:
                    raise PredictionError("artifact-missing", "Requested backup contents are unavailable.")
                checksum = ticket["artifact"]["manifest_sha256"]
                target = self.store.path(kind + "s", identity, revision)
                if target.exists():
                    with self.store.read_lease(kind + "s", identity, revision, cancel):
                        manifest, _, existing = self.store.read(kind + "s", identity, revision, cancel=cancel)
                    if existing != checksum:
                        raise PredictionError("revision-conflict", "This revision already contains different bytes on the target storage.")
                    artifact = {"identity": identity, "revision": revision, "manifest_sha256": checksum,
                                "format_version": 1, "files": manifest["files"]}
                else:
                    transfer.download(kind, working / f"{kind}.zip", ticket)
                    artifact = unpack_archive(working / f"{kind}.zip", working / kind, kind, identity, revision,
                                              checksum, cancel, self.memory_budget)
                staged[kind] = (identity, revision, checksum, artifact)
            check_cancel(cancel)
            for kind, (identity, revision, checksum, artifact) in staged.items():
                self.store.publish_replica(kind + "s", identity, revision, working / kind, checksum, cancel)
                receipt["artifacts"][kind] = artifact
                receipt["state"] = "published"
                self.store.save_receipt(receipt["operationId"], receipt)
        return self._finish(receipt, transfer, {kind: {key: value[key] for key in ("manifest_sha256", "files", "format_version")}
                                              for kind, value in receipt["artifacts"].items()})

    def _remove(self, payload, operation, receipt, transfer, cancel):
        replica = next((item for item in operation.get("replicas", []) if item["id"] == payload["replicaId"]), None)
        if (operation["kind"] not in ("delete_replica", "delete_asset") or replica is None
                or replica["storage_id"] != self.store.storage_id or replica["revision"] != payload["revision"]
                or operation["asset_kind"] != payload["kind"] or operation["asset_id"] != payload["identity"]):
            raise PredictionError("operation-conflict", "Removal differs from its authorized storage copy.")
        if replica.get("blocked"):
            raise PredictionError("copy-in-use", replica.get("error") or "This copy is still being used; retry after its sessions finish.")
        if payload["kind"] not in ("model", "dataset"):
            raise PredictionError("invalid-reference", "Unknown artifact category.")
        kind = payload["kind"] + "s"
        # The scoped replica identity authorizes removal even when its manifest is damaged.
        self.store.remove_replica(kind, payload["identity"], payload["revision"], cancel)
        receipt["removedReplicaId"] = payload["replicaId"]
        return self._finish(receipt, transfer, {"replica_id": payload["replicaId"]})
