"""Durable training receipts and Dataset pins, independent of loaded handles."""
from __future__ import annotations

import json
import math
import os
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener

from prediction_contracts import validate_training_update

from .dataset import NoRedirect
from .errors import PredictionError
from .models import ModelBundle, implementation_for
from .representations import vars_samples
from .storage import check_cancel, encode_json, safe_id


class TrainingOperations:
    def __init__(self, store, api_url: str, reader, model_context):
        self.store, self.api_url = store, api_url.rstrip("/")
        self.reader, self.model_context = reader, model_context
        self.opener = build_opener(NoRedirect())

    def authority(self, grant: dict, cancel=None) -> dict:
        operation_id = safe_id(grant["operation_id"])
        trusted, actual = urlparse(self.api_url), urlparse(grant["manifest_url"])
        expected = trusted.path.rstrip("/") + f"/prediction/operations/{quote(operation_id, safe='')}/training"
        if ((actual.scheme, actual.netloc, actual.path) != (trusted.scheme, trusted.netloc, expected)
                or actual.username or actual.password or actual.query or actual.fragment):
            raise PredictionError("data-access", "Training grant does not belong to its trusted API scope.")
        check_cancel(cancel)
        try:
            with self.opener.open(Request(grant["manifest_url"], headers={"Authorization": f"Bearer {grant['token']}"}), timeout=60) as response:
                raw = response.read(1024 * 1024 + 1)
        except HTTPError as error:
            raise PredictionError("data-access", f"Training authority rejected access (HTTP {error.code}).") from None
        if len(raw) > 1024 * 1024:
            raise PredictionError("memory-limit", "Training authority exceeds its metadata budget.")
        spec = json.loads(raw)
        if (spec.get("operationId") != operation_id or spec.get("storageId") != self.store.storage_id
                or spec.get("launcherId") != self.store.launcher_id):
            raise PredictionError("operation-conflict", "Training authorization belongs to another operation or storage.")
        check_cancel(cancel)
        return spec

    def saved_artifact(self, spec: dict, cancel=None) -> dict | None:
        model = spec["model"]
        target = self.store.path("models", model["modelId"], model["revision"])
        if not target.exists():
            return None
        if self.store.deleted(model["modelId"], model["revision"]):
            raise PredictionError("deleted", "This model revision has been deleted.")
        with self.store.read_lease("models", model["modelId"], model["revision"], cancel):
            manifest, path, checksum = self.store.read("models", model["modelId"], model["revision"], cancel=cancel)
            content = json.loads((path / "model.json").read_bytes())
            metadata = content["metadata"]
            if (any(metadata.get(key) != model[key] for key in ("modelId", "revision", "operationId"))
                    or metadata.get("definition") != spec["definition"]
                    or metadata.get("datasetId") != spec["dataset"]["datasetId"]
                    or metadata.get("datasetRevision") != spec["dataset"]["revision"]
                    or metadata.get("datasetFingerprint") != spec["dataset"]["fingerprint"]
                    or metadata.get("update") != spec.get("update")
                    or manifest["metadata"].get("update") != spec.get("update")):
                raise PredictionError("revision-conflict", "Saved model revision belongs to another training operation.")
            expected = implementation_for(metadata["definition"]).validate_artifact(path, manifest, content)
            if expected != {file["name"] for file in manifest["files"]}:
                raise PredictionError("artifact-checksum", "Saved model inventory differs from its implementation.")
        return {**manifest["metadata"], "storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                "files": manifest["files"], "manifestChecksum": checksum, "verified": True}

    def base_artifact(self, spec: dict, cancel=None) -> dict | None:
        base = (spec.get("update") or {}).get("baseModel")
        if base is None:
            return None
        if base["storageId"] != self.store.storage_id:
            raise PredictionError("storage-mismatch", "Training base model must be on the selected training storage.")
        if self.store.deleted(base["modelId"], base["revision"]):
            raise PredictionError("deleted", "Training base model revision has been deleted.")
        manifest, path, checksum = self.store.read("models", base["modelId"], base["revision"], cancel=cancel)
        content = json.loads((path / "model.json").read_bytes())
        metadata = content["metadata"]
        before = spec["update"]["changeSet"]["baseSnapshot"]
        if (checksum != base["checksum"] or metadata.get("direction") != "forward"
                or metadata.get("modelId") != base["modelId"] or metadata.get("revision") != base["revision"]
                or any(metadata.get(key) != before[other] for key, other in
                       (("datasetId", "datasetId"), ("datasetRevision", "revision"), ("datasetFingerprint", "fingerprint")))):
            raise PredictionError("artifact-checksum", "Training base model differs from its frozen model or Dataset reference.")
        expected_files = implementation_for(metadata["definition"]).validate_artifact(path, manifest, content)
        if expected_files != {file["name"] for file in manifest["files"]}:
            raise PredictionError("artifact-checksum", "Training base model inventory differs from its implementation.")
        return metadata

    def reconcile_model(self, identity: str, cancel=None) -> None:
        for pin in (self.store.path("models", identity) / "training-pins").glob("*.json"):
            content = json.loads(pin.read_bytes())
            try:
                spec = self.authority(content["grant"], cancel)
            except (PredictionError, OSError):
                continue
            if spec.get("canRelease") and spec["pinId"] == content["pinId"]:
                with self.store.transaction(cancel):
                    pin.unlink(missing_ok=True)

    def reconcile_dataset(self, identity: str, cancel=None) -> None:
        directory = self.store.path("datasets", identity) / "training-pins"
        for pin in directory.glob("*.json"):
            content = json.loads(pin.read_bytes())
            try:
                spec = self.authority(content["grant"], cancel)
            except (PredictionError, OSError):
                continue  # A missing authority is never evidence that cleanup finished.
            if spec.get("canRelease") and spec["pinId"] == content["pinId"]:
                with self.store.transaction(cancel):
                    pin.unlink(missing_ok=True)

    def _ack_pin(self, grant: dict, pin_id: str, saved: bool, cancel=None) -> dict:
        check_cancel(cancel)
        request = Request(grant["manifest_url"] + "/pinned", method="POST",
                          headers={"Authorization": f"Bearer {grant['token']}", "Content-Type": "application/json"},
                          data=encode_json({"pinId": pin_id, "artifactSaved": saved}))
        try:
            with self.opener.open(request, timeout=60) as response:
                response.read(1024 * 1024)
        except HTTPError as error:
            raise PredictionError("data-access", f"Training pin acknowledgement failed (HTTP {error.code}).") from None
        return {"operationId": grant["operation_id"], "pinId": pin_id}

    def run(self, action: str, payload: dict, cancel=None) -> dict:
        spec = self.authority(payload["grant"], cancel)
        try:
            validate_training_update(spec.get("update"), spec["definition"])
        except ValueError as error:
            raise PredictionError("unsupported-update", str(error)) from error
        operation_id, pin_id = safe_id(spec["operationId"]), safe_id(spec["pinId"])
        reference = spec["dataset"]
        pin = self.store.path("datasets", reference["datasetId"]) / "training-pins" / f"{pin_id}.json"
        base = (spec.get("update") or {}).get("baseModel")
        base_pin = self.store.path("models", base["modelId"]) / "training-pins" / f"{pin_id}.json" if base else None
        if action == "training.inspect":
            return {"receipt": self.store.receipt(operation_id), "artifact": self.saved_artifact(spec, cancel)}
        if action == "training.unpin" and not spec.get("canRelease"):
            raise PredictionError("training-active", "Training has not completed process cleanup.")
        if action == "training.pin" and not spec.get("canPin"):
            raise PredictionError("training-state", "This training operation cannot pin its Dataset.")
        with self.store.transaction(cancel, operation_id=operation_id):
            if action == "training.pin":
                # A delayed authority response can predate a newer preflight. Recheck
                # after serializing pin installations before removing any old pin.
                spec = self.authority(payload["grant"], cancel)
                if spec["pinId"] != pin_id or not spec.get("canPin"):
                    raise PredictionError("training-state", "This training preflight was replaced before its Dataset was pinned.")
            if action == "training.unpin":
                with self.store.transaction(cancel):
                    if pin.exists():
                        content = json.loads(pin.read_bytes())
                        if content["operationId"] != operation_id or content["pinId"] != pin_id:
                            raise PredictionError("operation-conflict", "Dataset pin belongs to another training attempt.")
                        pin.unlink()
                    if base_pin is not None and base_pin.exists():
                        content = json.loads(base_pin.read_bytes())
                        if content["operationId"] != operation_id or content["pinId"] != pin_id:
                            raise PredictionError("operation-conflict", "Base model pin belongs to another training attempt.")
                        base_pin.unlink()
                return {"operationId": operation_id, "pinId": pin_id, "released": True}
            if action != "training.pin" or not spec.get("canPin"):
                raise PredictionError("training-state", "This training operation cannot pin its Dataset.")
            with self.store.transaction(cancel):
                for previous in pin.parent.glob("*.json"):
                    content = json.loads(previous.read_bytes())
                    if content["operationId"] == operation_id and content["pinId"] != pin_id:
                        previous.unlink()  # A new authorized preflight follows previous process cleanup.
            if self.saved_artifact(spec, cancel) is not None:
                return self._ack_pin(payload["grant"], pin_id, True, cancel)
            if base is not None:
                with self.store.read_lease("models", base["modelId"], base["revision"], cancel):
                    self.base_artifact(spec, cancel)
                    expected_base = {"operationId": operation_id, "pinId": pin_id, "baseModel": base}
                    with self.store.transaction(cancel):
                        for previous in base_pin.parent.glob("*.json"):
                            content = json.loads(previous.read_bytes())
                            if content["operationId"] == operation_id and content["pinId"] != pin_id:
                                previous.unlink()
                        if base_pin.exists() and any(json.loads(base_pin.read_bytes()).get(key) != value for key, value in expected_base.items()):
                            raise PredictionError("operation-conflict", "Base model pin belongs to another training input.")
                        base_pin.parent.mkdir(parents=True, exist_ok=True)
                        temporary = base_pin.with_suffix(".pending")
                        with temporary.open("wb") as stream:
                            stream.write(encode_json({**expected_base, "grant": payload["grant"]}))
                            stream.flush()
                            os.fsync(stream.fileno())
                        os.replace(temporary, base_pin)
            if spec["sourceKind"] == "api":
                return self._ack_pin(payload["grant"], pin_id, False, cancel)
            if spec["sourceKind"] != "local":
                raise PredictionError("invalid-reference", "Unsupported training Dataset source.")
            expected = {"operationId": operation_id, "pinId": pin_id, **reference}
            with self.store.read_lease("datasets", reference["datasetId"], reference["revision"], cancel):
                manifest, _, _ = self.store.read("datasets", reference["datasetId"], reference["revision"], cancel=cancel)
                if manifest["metadata"].get("fingerprint") != reference["fingerprint"]:
                    raise PredictionError("dataset-checksum", "Dataset differs from the reserved training fingerprint.")
                with self.store.transaction(cancel):
                    if self.store.latest_dataset(reference["datasetId"]) != reference["revision"]:
                        raise PredictionError("dataset-unavailable", "The exact training Dataset revision is no longer current.")
                    if pin.exists() and any(json.loads(pin.read_bytes()).get(key) != value for key, value in expected.items()):
                        raise PredictionError("operation-conflict", "Dataset pin belongs to another training input.")
                    pin.parent.mkdir(parents=True, exist_ok=True)
                    temporary = pin.with_suffix(".pending")
                    with temporary.open("wb") as stream:
                        stream.write(encode_json({**expected, "grant": payload["grant"]}))
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, pin)
            return self._ack_pin(payload["grant"], pin_id, False, cancel)

    def train(self, spec: dict, dataset_reference, cancel=None, progress=None) -> dict:
        operation_id = safe_id(spec["operationId"])
        if (spec.get("storageId") != self.store.storage_id or spec.get("launcherId") != self.store.launcher_id
                or spec["model"].get("operationId") != operation_id):
            raise PredictionError("operation-conflict", "Training assignment belongs to another operation or storage.")
        try:
            mode = validate_training_update(spec.get("update"), spec["definition"])
        except ValueError as error:
            raise PredictionError("unsupported-model", str(error)) from error
        model = spec["model"]
        receipt = {"operationId": operation_id, "pinId": spec["pinId"], "kind": "training", "state": "preparing",
                   "model": model, "dataset": spec["dataset"], "definition": spec["definition"]}
        if spec.get("update") is not None:
            receipt["update"] = deepcopy(spec["update"])
            if spec["update"]["targetSnapshot"] != spec["dataset"]:
                raise PredictionError("dataset-checksum", "Training update targets another Dataset revision.")
        def report(value):
            check_cancel(cancel)
            receipt["progress"] = {"stage": value} if isinstance(value, str) else value
            self.store.save_receipt(operation_id, receipt)
            if progress:
                progress(value)
        with self.store.transaction(cancel, operation_id=operation_id), self.store.transaction(
                cancel, operation_id=f"prepare-{model['modelId']}-{model['revision']}"), self.store.read_lease(
                "models", model["modelId"], model["revision"], cancel, allow_missing=True):
            try:
                artifact = self.saved_artifact(spec, cancel)
                if artifact is None:
                    self.store.save_receipt(operation_id, receipt)
                    report("loading-dataset")
                    if spec["sourceKind"] == "local":
                        pin = self.store.path("datasets", spec["dataset"]["datasetId"]) / "training-pins" / f"{safe_id(spec['pinId'])}.json"
                        expected_pin = {"operationId": operation_id, "pinId": spec["pinId"], **spec["dataset"]}
                        if not pin.exists() or any(json.loads(pin.read_bytes()).get(key) != value for key, value in expected_pin.items()):
                            raise PredictionError("dataset-unavailable", "Training requires its durable preflight Dataset pin.")
                    reference = dataset_reference()
                    dataset = self.reader.load(reference, cancel, spec["definition"])
                    if any(dataset[key] != spec["dataset"][key] for key in ("datasetId", "revision", "fingerprint")):
                        raise PredictionError("dataset-checksum", "Training input differs from its pinned Dataset revision.")
                    report("training")
                    base = (spec.get("update") or {}).get("baseModel")
                    with ExitStack() as base_access:
                        base_model = None
                        if base is not None:
                            pin = self.store.path("models", base["modelId"]) / "training-pins" / f"{safe_id(spec['pinId'])}.json"
                            expected = {"operationId": operation_id, "pinId": spec["pinId"], "baseModel": base}
                            if not pin.exists() or any(json.loads(pin.read_bytes()).get(key) != value for key, value in expected.items()):
                                raise PredictionError("model-in-use", "Training requires its durable preflight base-model pin.")
                            base_access.enter_context(self.store.read_lease("models", base["modelId"], base["revision"], cancel))
                            self.base_artifact(spec, cancel)
                            if mode != "rebuild":
                                base_model, _ = ModelBundle.load(self.store, base["modelId"], base["revision"], self.model_context(cancel, report))
                        try:
                            context = self.model_context(cancel, report)
                            if base_model is not None:
                                context = replace(context, available_ram_bytes=max(0, context.available_ram_bytes - base_model.persistent_bytes))
                            bundle = ModelBundle.prepare(dataset, "forward", spec["definition"], model, context,
                                                         update=spec.get("update"), base_model=base_model)
                            try:
                                included = set(bundle.profile()["includedMeasurementIds"])
                                sample = next((row for row in sorted(dataset["measurements"], key=lambda row: row["id"])
                                               if row["id"] in included), None)
                                if sample is None:
                                    raise PredictionError("model-validation", "Trained model has no frozen sample for prediction validation.")
                                vars_samples(sample["vars"], dataset["varsSchema"])
                                receipt["validationInput"] = {"measurementId": sample["id"], "vars": deepcopy(sample["vars"])}
                                bundle.metadata["validationSample"] = deepcopy(receipt["validationInput"])
                                report("saving")
                                artifact = bundle.save(self.store, cancel)
                            finally:
                                bundle.close()
                        finally:
                            if base_model is not None:
                                base_model.close()
                else:
                    previous = self.store.receipt(operation_id) or {}
                    for key in ("validationInput", "validation"):
                        if key in previous:
                            receipt[key] = previous[key]
                report("validating")
                validation = self.validate_saved(spec, artifact, receipt, cancel)
                artifact = {**artifact, "validation": validation}
                receipt["validation"] = validation
                receipt.update(state="saved", artifact=artifact)
                self.store.save_receipt(operation_id, receipt)
                report("saved")
                return {"artifact": artifact}
            except BaseException as error:
                receipt.update(state="cancelled" if isinstance(error, PredictionError) and error.code == "cancelled" else "interrupted",
                               error={"code": getattr(error, "code", "training-failed"), "message": str(error)})
                self.store.save_receipt(operation_id, receipt)
                raise

    def validate_saved(self, spec: dict, artifact: dict, receipt: dict, cancel=None) -> dict:
        validation = receipt.get("validation")
        if (isinstance(validation, dict) and validation.get("version") == 1
                and validation.get("manifestChecksum") == artifact["manifestChecksum"]
                and validation.get("loadPassed") is True and validation.get("predictPassed") is True):
            return validation
        model = spec["model"]
        loaded, actual = ModelBundle.load(self.store, model["modelId"], model["revision"], self.model_context(cancel))
        try:
            if actual["manifestChecksum"] != artifact["manifestChecksum"]:
                raise PredictionError("artifact-checksum", "Reloaded model differs from the saved training artifact.")
            sample = receipt.get("validationInput") or loaded.metadata.get("validationSample")
            if sample is None:
                # Legacy recovery has no frozen smoke sample. Schema minimums
                # provide a valid inference query without restoring its Dataset.
                variables = {}
                for key, entry in loaded.metadata["varsSchema"].items():
                    value = entry["min"]
                    for length in reversed(entry["shape"]):
                        value = [deepcopy(value) for _ in range(length)]
                    variables[key] = value
                sample = {"measurementId": None, "vars": variables}
            context = self.model_context(cancel)
            context = replace(context, available_ram_bytes=max(0, context.available_ram_bytes - loaded.persistent_bytes))
            result = loaded.predict({"direction": "forward", "vars": sample["vars"]}, context)
            outputs = result.get("output")
            if (result.get("direction") != "forward" or result.get("fingerprint") != spec["definition"]["fingerprint"]
                    or not isinstance(outputs, list) or not outputs
                    or len(outputs) != len(loaded.implementation.output_layouts)):
                raise PredictionError("model-validation", "Reloaded model did not produce its Forward output contract.")
            for output, expected_layout in zip(outputs, loaded.implementation.output_layouts):
                layout, values = output.get("layout", {}), output.get("values")
                shape = layout.get("shape")
                expected = math.prod(shape) + (shape[4] if layout.get("frequencyOutput") else 0) if isinstance(shape, list) else 0
                if (layout != expected_layout or not isinstance(values, list) or not expected or len(values) != expected
                        or any(type(value) not in (int, float) or not math.isfinite(value) for value in values)):
                    raise PredictionError("model-validation", "Reloaded model prediction contains invalid output values.")
            check_cancel(cancel)
            return {"version": 1, "manifestChecksum": artifact["manifestChecksum"], "loadPassed": True,
                    "predictPassed": True, "measurementId": sample["measurementId"]}
        finally:
            loaded.close()
