"""Direct scoped API import; checked local manifests never accept arbitrary paths."""
from __future__ import annotations

import base64
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile
import threading
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .errors import PredictionError
from .storage import ArtifactStore, check_cancel, encode_json, safe_id


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PredictionError("data-access", "Dataset downloads must not redirect credentials.")


def references(value) -> dict[str, dict]:
    found = {}
    def visit(member):
        if isinstance(member, dict) and member.get("kind") == "caemble.object":
            if member.get("version") != 1 or member.get("encoding") not in ("json", "base64"):
                raise PredictionError("dataset-format", "Unsupported Dataset object reference.")
            previous = found.get(member["id"])
            if previous and previous != member:
                raise PredictionError("dataset-checksum", "Conflicting references for a Dataset object.")
            found[member["id"]] = member
        elif isinstance(member, dict):
            for item in member.values():
                visit(item)
        elif isinstance(member, list):
            for item in member:
                visit(item)
    visit(value)
    return found


def content_identity(value):
    if isinstance(value, dict):
        return {key: content_identity(member) for key, member in value.items()
                if key != "id" or value.get("kind") != "caemble.object"}
    if isinstance(value, list):
        return [content_identity(member) for member in value]
    return value


class DatasetReader:
    def __init__(self, store: ArtifactStore, api_url: str, memory_budget: int):
        self.store, self.api_url, self.memory_budget = store, api_url.rstrip("/"), memory_budget
        self.opener = build_opener(NoRedirect())

    def _api_request(self, url: str, token: str) -> Request:
        trusted, actual = urlparse(self.api_url), urlparse(url)
        if (actual.scheme, actual.netloc) != (trusted.scheme, trusted.netloc) or not actual.path.startswith(trusted.path.rstrip("/") + "/prediction/datasets/"):
            raise PredictionError("data-access", "Dataset grant does not belong to the launcher's trusted API.")
        if actual.username or actual.password or actual.fragment:
            raise PredictionError("data-access", "Dataset grant URL is invalid.")
        return Request(url, headers={"Authorization": f"Bearer {token}"})

    def _json(self, request: Request) -> tuple[dict, bytes]:
        with self.opener.open(request, timeout=60) as response:
            raw = response.read(self.memory_budget + 1)
        if len(raw) > self.memory_budget:
            raise PredictionError("memory-limit", f"Dataset metadata exceeds the available {self.memory_budget:,}-byte memory budget.")
        return json.loads(raw), raw

    @staticmethod
    def _expires_at(grant: dict) -> float:
        expires = grant.get("expires_at")
        if expires is None:
            return float("inf")
        try:
            return float(expires) if isinstance(expires, (int, float)) else datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError, AttributeError) as error:
            raise PredictionError("data-access", "Dataset grant expiration is invalid.") from error

    def _renew_grant(self, grant: dict, cancel: threading.Event | None) -> None:
        check_cancel(cancel)
        refresh_url = grant.get("refresh_url")
        if not refresh_url:
            raise PredictionError("data-access", "Dataset access expired. Request a new grant for this revision.")
        expected_path = urlparse(self.api_url).path.rstrip("/") + f"/prediction/datasets/{quote(grant['dataset_id'], safe='')}/revisions/{grant['revision']}/grant/renew"
        if urlparse(refresh_url).path != expected_path or urlparse(refresh_url).query:
            raise PredictionError("data-access", "Dataset grant renewal URL does not match its pinned revision.")
        request = self._api_request(refresh_url, grant["token"])
        request.method = "POST"
        request.data = b""
        try:
            renewed, _ = self._json(request)
        except HTTPError as error:
            raise PredictionError("data-access", f"Dataset grant renewal was rejected (HTTP {error.code}); the grant may be released or retired.") from error
        pinned = ("dataset_id", "revision", "fingerprint", "manifest_sha256", "manifest_url", "object_url_template", "refresh_url", "grant_id")
        if any(renewed.get(key) != grant.get(key) for key in pinned):
            raise PredictionError("data-access", "Renewed Dataset grant changed its pinned revision or access scope.")
        if not isinstance(renewed.get("token"), str) or not renewed["token"] or self._expires_at(renewed) <= time.time():
            raise PredictionError("data-access", "Renewed Dataset grant is already expired or invalid.")
        grant.update(renewed)

    def _grant_json(self, grant: dict, url: str, cancel: threading.Event | None) -> tuple[dict, bytes]:
        check_cancel(cancel)
        refreshed = False
        if self._expires_at(grant) <= time.time() + 30 and grant.get("refresh_url"):
            self._renew_grant(grant, cancel)
            refreshed = True
        try:
            return self._json(self._api_request(url, grant["token"]))
        except HTTPError as error:
            if error.code == 401 and not refreshed and grant.get("refresh_url"):
                self._renew_grant(grant, cancel)
                check_cancel(cancel)
                try:
                    return self._json(self._api_request(url, grant["token"]))
                except HTTPError as retry_error:
                    raise PredictionError("data-access", f"Dataset access was rejected after grant renewal (HTTP {retry_error.code}).") from retry_error
            raise PredictionError("data-access", f"Dataset access was rejected (HTTP {error.code}).") from error

    def import_grant(self, grant: dict, cancel: threading.Event | None = None) -> dict:
        check_cancel(cancel)
        grant = dict(grant)
        manifest, raw = self._grant_json(grant, grant["manifest_url"], cancel)
        if hashlib.sha256(raw).hexdigest() != grant["manifest_sha256"]:
            raise PredictionError("dataset-checksum", "Dataset manifest checksum differs from its grant.")
        self.validate(manifest)
        for manifest_key, grant_key in (("datasetId", "dataset_id"), ("revision", "revision"), ("fingerprint", "fingerprint")):
            if manifest[manifest_key] != grant[grant_key]:
                raise PredictionError("dataset-checksum", "Dataset revision differs from its grant.")
        refs = references(manifest)
        metadata = {key: manifest[key] for key in ("datasetId", "revision", "fingerprint", "experimentId")}
        metadata["name"] = manifest.get("name", manifest["datasetId"])
        metadata.update(self.summary(manifest, "server-cache"))
        self.store.discard_unpublished_dataset(manifest["datasetId"], cancel)
        existing_path = self.store.path("datasets", manifest["datasetId"], manifest["revision"])
        if existing_path.exists():
            existing, _, _ = self.store.read("datasets", manifest["datasetId"], manifest["revision"])
            stored_manifest = next((file for file in existing["files"] if file["name"] == "dataset.json"), None)
            if not stored_manifest or stored_manifest["sha256"] != hashlib.sha256(raw).hexdigest():
                raise PredictionError("revision-conflict", "Dataset revision already contains a different manifest.")

        def write(path: Path):
            (path / "dataset.json").write_bytes(raw)
            downloaded = set()
            for object_id, ref in refs.items():
                check_cancel(cancel)
                sha = ref["sha256"]
                if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
                    raise PredictionError("dataset-checksum", "Invalid object checksum.")
                if sha in downloaded:
                    continue
                url = grant["object_url_template"].replace("{object_id}", quote(object_id, safe="")).replace("{objectId}", quote(object_id, safe=""))
                ticket, _ = self._grant_json(grant, url, cancel)
                ticket_ref = ticket.get("reference", {})
                if any(ticket_ref.get(key) != ref.get(key) for key in ("id", "sha256", "byteLength", "encoding")):
                    raise PredictionError("dataset-checksum", "Object ticket does not match the Dataset reference.")
                digest, length = hashlib.sha256(), 0
                with (path / f"{sha}.object").open("wb") as stream:
                    for part in ticket["parts"]:
                        check_cancel(cancel)
                        parsed = urlparse(part["url"])
                        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or any(key.lower() in ("authorization", "cookie") for key in part.get("headers", {})):
                            raise PredictionError("data-access", "Unsupported object download URL.")
                        chunk_digest, chunk_length = hashlib.sha256(), 0
                        with self.opener.open(Request(part["url"], headers=part.get("headers", {})), timeout=60) as response:
                            while True:
                                check_cancel(cancel)
                                chunk = response.read(min(1024 * 1024, part["byteLength"] - chunk_length + 1))
                                if not chunk:
                                    break
                                chunk_length += len(chunk)
                                if chunk_length > part["byteLength"]:
                                    raise PredictionError("dataset-checksum", "Object chunk exceeds its declared length.")
                                chunk_digest.update(chunk)
                                digest.update(chunk)
                                stream.write(chunk)
                        if chunk_length != part["byteLength"] or chunk_digest.hexdigest() != part["sha256"]:
                            raise PredictionError("dataset-checksum", "Object chunk checksum differs from its manifest.")
                        length += chunk_length
                if length != ref["byteLength"] or digest.hexdigest() != sha:
                    raise PredictionError("dataset-checksum", "Dataset object checksum differs from its reference.")
                downloaded.add(sha)
        self.store.write("datasets", manifest["datasetId"], manifest["revision"], metadata, write, cancel)
        check_cancel(cancel)
        self.store.publish_dataset(manifest["datasetId"], manifest["revision"])
        return metadata | {"storageId": self.store.storage_id, "launcherId": self.store.launcher_id, "available": True}

    @staticmethod
    def summary(manifest: dict, source_kind: str) -> dict:
        contracts = {"experimentId": manifest["experimentId"], "sourceHash": manifest.get("sourceHash"),
                     **{key: manifest.get(key, [] if key in ("records", "rules") else {})
                        for key in ("varsSchema", "records", "rules", "resultContracts")}, "calculations": []}
        for calculation in manifest.get("calculations", []):
            item = {key: calculation[key] for key in ("id", "name", "source_hash", "source_revision", "revision", "contract_status", "experiment_record_ids") if key in calculation}
            layout = calculation.get("output_layout")
            if layout:
                item["output_layout"] = {"dtype": layout["dtype"], "shape": layout["shape"],
                                         "axes": [{"name": axis["name"], **({"unit": axis["unit"]} if axis.get("unit") else {})}
                                                  for axis in layout["axes"]]}
            contracts["calculations"].append(item)
        return {"sourceKind": source_kind, "sourceHash": manifest.get("sourceHash"),
                "sampleCount": len(manifest["measurements"]), "sourceContracts": contracts}

    def import_local(self, import_id: str, cancel: threading.Event | None = None, experiment_id: int | None = None,
                     *, dataset_id: str | None = None, preview: bool = False) -> dict:
        imports = (self.store.namespace / "imports").resolve()
        source = (imports / safe_id(import_id)).resolve()
        if not source.is_relative_to(imports) or source.is_symlink():
            raise PredictionError("invalid-reference", "Local Dataset import must remain inside its managed import directory.")
        try:
            raw = (source / "manifest.json").read_bytes()
            bundle = json.loads(raw)
            if bundle.get("kind") != "caemble.prediction.dataset.artifact" or bundle.get("version") != 1:
                raise PredictionError("dataset-format", "Local import requires a Caemble Dataset bundle v1.")
            names = set()
            for file in bundle["files"]:
                check_cancel(cancel)
                name = file["name"]
                if name != "dataset.json" and not (len(name) == 71 and name.endswith(".object") and all(char in "0123456789abcdef" for char in name[:64])):
                    raise PredictionError("dataset-format", "Local Dataset bundle contains an unsupported filename.")
                if name in names:
                    raise PredictionError("dataset-format", "Local Dataset bundle contains duplicate files.")
                names.add(name)
                path = (source / name).resolve()
                if not path.is_relative_to(source) or path.is_symlink() or path.stat().st_size != file["byteLength"]:
                    raise PredictionError("dataset-checksum", "Local Dataset file is missing or has a different length.")
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        check_cancel(cancel)
                        digest.update(chunk)
                if digest.hexdigest() != file["sha256"]:
                    raise PredictionError("dataset-checksum", "Local Dataset file checksum differs from its manifest.")
            if "dataset.json" not in names:
                raise PredictionError("dataset-format", "Local Dataset bundle has no dataset.json.")
            dataset_bytes = (source / "dataset.json").read_bytes()
            declared_dataset = next(file for file in bundle["files"] if file["name"] == "dataset.json")
            if hashlib.sha256(dataset_bytes).hexdigest() != declared_dataset["sha256"]:
                raise PredictionError("dataset-checksum", "Dataset source changed during import.")
            manifest = json.loads(dataset_bytes)
            self.validate(manifest)
            if experiment_id is not None and manifest["experimentId"] != experiment_id:
                raise PredictionError("dataset-source", "Local Dataset belongs to a different Experiment.")
            if bundle["identity"] != manifest["datasetId"] or bundle["revision"] != manifest["revision"]:
                raise PredictionError("dataset-checksum", "Local Dataset identity differs from its bundle manifest.")
            if any(f"{ref['sha256']}.object" not in names for ref in references(manifest).values()):
                raise PredictionError("dataset-checksum", "Local Dataset bundle is missing a referenced object.")
            identity = dataset_id or str(uuid.uuid5(uuid.UUID(self.store.storage_id), f"{self.store.namespace.name}/dataset/{import_id}"))
            if self.store.dataset_deleted(identity):
                raise PredictionError("deleted", "This local Dataset was deleted. Use a different import ID to create a new Dataset.")
            if preview:
                current = self.store.latest_dataset(identity)
                previous_manifest, previous_path, _ = self.store.read("datasets", identity, current, cancel=cancel)
                previous = previous_manifest["metadata"]
                if previous["experimentId"] != manifest["experimentId"] or previous["origin"]["datasetId"] != manifest["datasetId"]:
                    raise PredictionError("dataset-source", "Local Dataset source changed to another Experiment or identity.")
                before = json.loads((previous_path / "dataset.json").read_bytes())
                def rows(value):
                    contracts = {key: member for key, member in value.items()
                                 if key not in ("datasetId", "revision", "fingerprint", "name", "origin", "measurements", "recorded", "calculationData")}
                    return {row["id"]: hashlib.sha256(encode_json(content_identity({"measurement": row, "contracts": contracts,
                        "recorded": sorted((item for item in value.get("recorded", []) if item["measurement_id"] == row["id"]), key=lambda item: item["id"]),
                        "calculations": sorted((item for item in value.get("calculationData", []) if item["measurement_id"] == row["id"]), key=lambda item: item["id"])}))).hexdigest()
                        for row in value["measurements"]}
                old, new = rows(before), rows(manifest)
                return {"added": len(new.keys() - old.keys()), "removed": len(old.keys() - new.keys()),
                        "changed": sum(old[key] != new[key] for key in old.keys() & new.keys())}
            self.store.discard_unpublished_dataset(identity, cancel)
            origin = {"datasetId": manifest["datasetId"], "revision": manifest["revision"], "fingerprint": manifest["fingerprint"]}
            content = {key: value for key, value in manifest.items() if key not in ("datasetId", "revision", "fingerprint", "name", "origin")}
            content_checksum = hashlib.sha256(encode_json(content_identity(content))).hexdigest()
            revision = 1
            if (self.store.path("datasets", identity) / "latest").exists():
                current = self.store.latest_dataset(identity)
                existing, _, checksum = self.store.read("datasets", identity, current)
                previous = existing["metadata"]
                if previous["experimentId"] != manifest["experimentId"] or previous["origin"]["datasetId"] != origin["datasetId"]:
                    raise PredictionError("dataset-source", "A local Dataset import ID cannot be rebound to another source Dataset or Experiment.")
                if previous["contentChecksum"] == content_checksum:
                    self.store.publish_dataset(identity, current)
                    return {**previous, "storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                            "manifestChecksum": checksum, "files": existing["files"], "available": True}
                if previous["fingerprint"] == manifest["fingerprint"]:
                    raise PredictionError("dataset-checksum", "Source content changed without a new Dataset fingerprint.")
                revision = current + 1
            operation_id = str(uuid.uuid5(uuid.UUID(self.store.storage_id), f"{identity}/{revision}/{manifest['fingerprint']}"))
            manifest = {**manifest, "datasetId": identity, "revision": revision, "origin": origin}
            metadata = {key: manifest[key] for key in ("datasetId", "revision", "fingerprint", "experimentId")}
            metadata.update({"name": manifest.get("name", bundle.get("metadata", {}).get("name", import_id)),
                             "operationId": operation_id, "importId": import_id, "origin": origin,
                             "contentChecksum": content_checksum, **self.summary(manifest, "local")})
            def write(target):
                (target / "dataset.json").write_bytes(encode_json(manifest))
                for file in bundle["files"]:
                    name = file["name"]
                    if name == "dataset.json":
                        continue
                    check_cancel(cancel)
                    shutil.copyfile(source / name, target / name)
                    digest = hashlib.sha256()
                    with (target / name).open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                    if (target / name).stat().st_size != file["byteLength"] or digest.hexdigest() != file["sha256"]:
                        raise PredictionError("dataset-checksum", "Dataset source file changed during import.")
            saved, _, checksum = self.store.write("datasets", manifest["datasetId"], manifest["revision"], metadata, write, cancel)
            check_cancel(cancel)
            self.store.publish_dataset(manifest["datasetId"], manifest["revision"])
            return {**metadata, "storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                    "manifestChecksum": checksum, "files": saved["files"], "available": True}
        except FileNotFoundError:
            raise PredictionError("dataset-missing", "Local Dataset import bundle is missing.") from None

    def sync_local(self, dataset_id: str, cancel: threading.Event | None = None, experiment_id: int | None = None,
                   *, preview: bool = False) -> dict:
        current = self.store.latest_dataset(dataset_id)
        manifest, _, _ = self.store.read("datasets", dataset_id, current)
        metadata = manifest["metadata"]
        if metadata.get("sourceKind") != "local" or not metadata.get("importId"):
            raise PredictionError("dataset-source", "This Dataset has no registered local import source.")
        return self.import_local(metadata["importId"], cancel, experiment_id, dataset_id=dataset_id, preview=preview)

    @staticmethod
    def validate(manifest: dict) -> None:
        if manifest.get("kind") != "caemble.prediction.dataset" or manifest.get("version") != 1:
            raise PredictionError("dataset-format", "Only Caemble Prediction Dataset manifest v1 is supported.")
        for key in ("datasetId", "revision", "fingerprint", "experimentId", "varsSchema", "measurements"):
            if key not in manifest:
                raise PredictionError("dataset-format", f"Dataset manifest is missing {key}.")

    def load(self, reference: dict, cancel: threading.Event | None = None,
             direction: str | None = None, definition: dict | None = None) -> dict:
        if "grant" in reference:
            transfers = self.store.namespace / ".transfers"
            transfers.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="dataset-", dir=transfers) as temporary:
                temporary_store = ArtifactStore(Path(temporary), "transfer", self.store.launcher_id)
                reader = DatasetReader(temporary_store, self.api_url, self.memory_budget)
                imported = reader.import_grant(reference["grant"], cancel)
                return reader.load(imported, cancel, direction, definition)
        parent = self.store.path("datasets", reference["datasetId"])
        latest = self.store.latest_dataset(reference["datasetId"]) if (parent / "latest").exists() else None
        if latest != reference["revision"] and not (parent / "retained" / str(reference["revision"])).exists():
            raise PredictionError("dataset-unavailable", "Only the latest local Dataset payload is retained; load its saved model instead.")
        _, path, _ = self.store.read("datasets", reference["datasetId"], reference["revision"], self.memory_budget, cancel)
        manifest = json.loads((path / "dataset.json").read_bytes())
        self.validate(manifest)
        if manifest["fingerprint"] != reference["fingerprint"]:
            raise PredictionError("dataset-checksum", "Dataset fingerprint differs from the requested revision.")
        definition = definition or {}
        for selection, member, id_key in (("calculationIds", "calculations", "id"), ("requiredRecordIds", "records", "id")):
            if selection in definition:
                selected = definition[selection]
                by_id = {item[id_key]: item for item in manifest.get(member, [])}
                if len(set(selected)) != len(selected) or any(identity not in by_id for identity in selected):
                    raise PredictionError("missing-contract", "Selected model contracts are not present in the Dataset revision.")
                manifest[member] = [by_id[identity] for identity in selected]
        record_ids = {item["id"] for item in manifest.get("records", [])}
        calculation_ids = {item["id"] for item in manifest.get("calculations", [])}
        manifest["recorded"] = [row for row in manifest.get("recorded", []) if row["experiment_record_id"] in record_ids] if direction != "inverse" else []
        manifest["calculationData"] = [row for row in manifest.get("calculationData", []) if row["calculation_id"] in calculation_ids] if direction != "forward" else []
        record_names = {item["name"] for item in manifest.get("records", [])}
        manifest["rules"] = [rule for rule in manifest.get("rules", []) if rule["label"] in record_names]
        cells = sum(math.prod(row["data"]["shape"]) for row in manifest["recorded"] + manifest["calculationData"])
        cells += len(manifest["measurements"]) * sum(math.prod(entry["shape"]) for entry in manifest["varsSchema"].values())
        # Python numeric lists, decoded bytes, input matrices and outputs coexist during preparation.
        if cells * 72 > self.memory_budget:
            raise PredictionError("memory-limit", f"Dataset decoding and model preparation need an estimated {cells * 72:,} bytes; {self.memory_budget:,} bytes are available.")
        cache = {}
        def resolve(value):
            check_cancel(cancel)
            if isinstance(value, dict) and value.get("kind") == "caemble.object":
                ref_id = value["id"]
                if ref_id not in cache:
                    raw = (path / f"{value['sha256']}.object").read_bytes()
                    if len(raw) != value["byteLength"] or hashlib.sha256(raw).hexdigest() != value["sha256"]:
                        raise PredictionError("dataset-checksum", "Local object differs from its pinned Dataset reference.")
                    cache[ref_id] = json.loads(raw) if value["encoding"] == "json" else base64.b64encode(raw).decode("ascii")
                return cache[ref_id]
            if isinstance(value, dict):
                return {key: resolve(member) for key, member in value.items()}
            if isinstance(value, list):
                return [resolve(member) for member in value]
            return value
        return resolve(manifest)
