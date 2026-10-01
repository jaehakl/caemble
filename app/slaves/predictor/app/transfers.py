"""Operation-scoped API grants and direct checksum-bound object transfers."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener

from .archives import CHUNK_BYTES, object_manifest
from .dataset import DatasetReader, NoRedirect
from .errors import PredictionError
from .storage import check_cancel, encode_json


class OperationTransfer:
    def __init__(self, api_url: str, grant: dict, cancel=None):
        self.api_url, self.grant, self.cancel = api_url.rstrip("/"), dict(grant), cancel
        self.opener = build_opener(NoRedirect())
        self.operation_id = self.grant["operation_id"]

    def _request(self, url: str, method: str, body=None):
        trusted, actual = urlparse(self.api_url), urlparse(url)
        prefix = trusted.path.rstrip("/") + f"/prediction/operations/{quote(self.operation_id, safe='')}/"
        if ((trusted.scheme, trusted.netloc) != (actual.scheme, actual.netloc)
                or not actual.path.startswith(prefix) or actual.username or actual.password or actual.fragment or actual.query):
            raise PredictionError("data-access", "Operation grant does not belong to its trusted API scope.")
        request = Request(url, method=method, headers={"Authorization": f"Bearer {self.grant['token']}", "Content-Type": "application/json"},
                          data=encode_json(body) if body is not None else None)
        check_cancel(self.cancel)
        with self.opener.open(request, timeout=60) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
        if len(raw) > 64 * 1024 * 1024:
            raise PredictionError("memory-limit", "Operation response exceeds the metadata budget.")
        check_cancel(self.cancel)
        return json.loads(raw)

    def _renew(self):
        if not self.grant.get("refresh_url"):
            raise PredictionError("data-access", "Operation access expired; retry with a new scoped grant.")
        try:
            renewed = self._request(self.grant["refresh_url"], "POST", {})
        except HTTPError as error:
            raise PredictionError("data-access", f"Operation grant renewal was rejected (HTTP {error.code}).") from None
        pinned = ("operation_id", "manifest_url", "prepare_url", "complete_url", "register_url", "refresh_url")
        if any(renewed.get(key) != self.grant.get(key) for key in pinned) or not renewed.get("token"):
            raise PredictionError("data-access", "Renewed operation grant changed its immutable scope.")
        self.grant = dict(renewed)

    def request(self, key: str, method: str = "GET", body=None, slot: str | None = None):
        if DatasetReader._expires_at(self.grant) <= time.time() + 30:
            self._renew()
        url = self.grant[key]
        if slot is not None:
            if slot not in ("model", "dataset"):
                raise PredictionError("invalid-reference", "Unknown archive slot.")
            url = url.replace("{slot}", slot)
        try:
            return self._request(url, method, body)
        except HTTPError as error:
            if error.code == 401 and self.grant.get("refresh_url"):
                self._renew()
                try:
                    return self._request(url, method, body)
                except HTTPError as retry:
                    raise PredictionError("data-access", f"Operation access was rejected (HTTP {retry.code}).") from None
            raise PredictionError("data-access", f"Operation access was rejected (HTTP {error.code}).") from None

    def describe(self):
        value = self.request("manifest_url")
        if value.get("operation", {}).get("id") != self.operation_id:
            raise PredictionError("operation-conflict", "Transfer response belongs to another operation.")
        return value

    def _part_request(self, part: dict, data=None):
        parsed = urlparse(part["url"])
        headers = part.get("headers", {})
        if (parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.fragment
                or any(key.lower() in ("authorization", "cookie", "host") for key in headers)):
            raise PredictionError("data-access", "Unsupported object transfer URL or headers.")
        return Request(part["url"], data=data, method="GET" if data is None else "PUT", headers=headers)

    def prepare(self, slot: str, path: Path, artifact: dict, dataset=None):
        manifest = object_manifest(path, self.cancel)
        body = {"manifest": manifest, "artifact": {key: artifact[key] for key in ("manifest_sha256", "files", "format_version")}}
        if dataset is not None:
            body["dataset"] = dataset
        ticket = self.request("prepare_url", "POST", body, slot)
        self._validate_ticket(ticket, manifest)
        return manifest, body, ticket

    def upload(self, slot: str, path: Path, artifact: dict, dataset=None):
        manifest, body, ticket = self.prepare(slot, path, artifact, dataset)
        if not ticket["ready"]:
            with path.open("rb") as stream:
                for index, expected in enumerate(manifest["chunks"]):
                    check_cancel(self.cancel)
                    if DatasetReader._expires_at(self.grant) <= time.time() + 30:
                        self._renew()
                    chunk = stream.read(expected["byteLength"])
                    if len(chunk) != expected["byteLength"] or hashlib.sha256(chunk).hexdigest() != expected["sha256"]:
                        raise PredictionError("artifact-checksum", "Archive changed during upload.")
                    for attempt in range(3):
                        part = ticket["parts"][index]
                        if any(part[key] != expected[key] for key in ("sha256", "byteLength")):
                            raise PredictionError("artifact-checksum", "Upload ticket differs from its archive.")
                        try:
                            with self.opener.open(self._part_request(part, chunk), timeout=60):
                                pass
                            break
                        except HTTPError as error:
                            if error.code == 412:
                                break  # Commit verifies bytes of the previous conditional upload.
                            if attempt == 2:
                                raise PredictionError("transfer-failed", f"Object upload failed (HTTP {error.code}).") from None
                        except OSError:
                            if attempt == 2:
                                raise PredictionError("transfer-failed", "Object upload was interrupted.") from None
                        check_cancel(self.cancel)
                        ticket = self.request("prepare_url", "POST", body, slot)
                        self._validate_ticket(ticket, manifest)
                        if ticket["ready"]:
                            break
                    if ticket["ready"]:
                        break
        return self.request("complete_url", "POST", {}, slot)

    @staticmethod
    def _validate_ticket(ticket, expected):
        reference = ticket["reference"]
        if any(reference.get(key) != expected[key] for key in ("encoding", "sha256", "byteLength")):
            raise PredictionError("artifact-checksum", "Object ticket differs from its pinned archive.")
        if not ticket.get("ready") and len(ticket.get("parts", [])) != len(expected["chunks"]):
            raise PredictionError("artifact-checksum", "Object ticket has an incomplete chunk inventory.")

    def download(self, slot: str, target: Path, ticket: dict | None = None):
        ticket = ticket or self.describe()[slot]
        reference = ticket["reference"]
        if reference.get("encoding") != "base64" or type(reference.get("byteLength")) is not int or reference["byteLength"] < 1:
            raise PredictionError("artifact-checksum", "Archive object reference is invalid.")
        target.parent.mkdir(parents=True, exist_ok=True)
        if reference["byteLength"] * 2 > shutil.disk_usage(target.parent).free:
            raise PredictionError("storage-full", "Insufficient disk space for the archive and restored files.")
        expected_parts = [{key: part[key] for key in ("sha256", "byteLength")} for part in ticket["parts"]]
        if sum(part["byteLength"] for part in expected_parts) != reference["byteLength"]:
            raise PredictionError("artifact-checksum", "Archive chunks differ from its declared length.")
        digest, length = hashlib.sha256(), 0
        with target.open("wb") as destination:
            for index, expected in enumerate(expected_parts):
                check_cancel(self.cancel)
                if DatasetReader._expires_at(self.grant) <= time.time() + 30:
                    self._renew()
                if type(expected["byteLength"]) is not int or not 0 < expected["byteLength"] <= CHUNK_BYTES:
                    raise PredictionError("artifact-checksum", "Archive chunk length is invalid.")
                for attempt in range(3):
                    try:
                        with self.opener.open(self._part_request(ticket["parts"][index]), timeout=60) as response:
                            raw = response.read(expected["byteLength"] + 1)
                        if len(raw) != expected["byteLength"] or hashlib.sha256(raw).hexdigest() != expected["sha256"]:
                            raise PredictionError("artifact-checksum", "Archive chunk checksum differs from its manifest.")
                        break
                    except (HTTPError, OSError):
                        if attempt == 2:
                            raise PredictionError("transfer-failed", "Archive download was interrupted.") from None
                        check_cancel(self.cancel)
                        ticket = self.describe()[slot]
                        if ticket["reference"] != reference or [{key: part[key] for key in ("sha256", "byteLength")} for part in ticket["parts"]] != expected_parts:
                            raise PredictionError("artifact-checksum", "Refreshed archive ticket changed its immutable content.")
                check_cancel(self.cancel)
                destination.write(raw)
                digest.update(raw)
                length += len(raw)
        if length != reference["byteLength"] or digest.hexdigest() != reference["sha256"]:
            raise PredictionError("artifact-checksum", "Downloaded archive checksum differs from its reference.")
        return ticket
