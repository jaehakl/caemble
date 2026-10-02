from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError
import hashlib
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from predictor.errors import PredictionError
from predictor.runtime import PredictorRuntime
from predictor.storage import encode_json
from .fixtures import dataset
from .test_prediction import call, prepare, runtime


@pytest.mark.parametrize("mode", ["expiring", "unauthorized", "revoked", "changed-scope"])
def test_grant_renewal_pins_revision_and_stops_after_revocation(tmp_path, mode):
    manifest = dataset()
    raw = encode_json(manifest)
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            token = self.headers.get("Authorization")
            requests.append(("GET", self.path, token))
            if token != "Bearer renewed":
                self.send_error(401)
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            requests.append(("POST", self.path, self.headers.get("Authorization")))
            if mode == "revoked":
                self.send_error(410)
                return
            renewed = {**grant, "token": "renewed", "expires_at": time.time() + 900}
            if mode == "changed-scope":
                renewed["revision"] = 2
            self.send_response(200)
            self.end_headers()
            self.wfile.write(encode_json(renewed))

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    origin = f"http://127.0.0.1:{server.server_port}"
    scope = origin + "/prediction/datasets/dataset-1/revisions/1"
    grant = {"manifest_url": scope + "/manifest", "object_url_template": scope + "/objects/{object_id}",
             "refresh_url": scope + "/grant/renew", "grant_id": "grant-1", "token": "original",
             "dataset_id": "dataset-1", "revision": 1, "fingerprint": manifest["fingerprint"],
             "manifest_sha256": hashlib.sha256(raw).hexdigest(),
             "expires_at": time.time() + (900 if mode == "unauthorized" else 5)}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        worker = PredictorRuntime(tmp_path, "owner", "launcher", origin, 1000000)
        if mode in ("revoked", "changed-scope"):
            with pytest.raises(PredictionError, match="rejected|pinned revision"):
                worker.reader.import_grant(grant)
            assert worker.store.list("datasets") == []
        else:
            imported = worker.reader.import_grant(grant)
            assert imported["fingerprint"] == manifest["fingerprint"]
            assert requests[-1] == ("GET", "/prediction/datasets/dataset-1/revisions/1/manifest", "Bearer renewed")
        assert len([request for request in requests if request[0] == "POST"]) == 1
        assert requests[0][0] == ("GET" if mode == "unauthorized" else "POST")
        assert grant["token"] == "original"  # Tokens are never persisted into the caller's reference.
        with pytest.raises(PredictionError, match="pinned revision"):
            worker.reader._renew_grant({**grant, "refresh_url": origin + "/prediction/datasets/other/revisions/1/grant/renew"}, None)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_other_process_serializes_cleanup_and_blocks_model_delete_until_release(tmp_path):
    worker = runtime(tmp_path)
    prepared = prepare(worker)
    call(worker, "model.release", instance=prepared["instance"])
    script = r'''
import importlib.util,sys
from pathlib import Path
package=Path(sys.argv[1]); spec=importlib.util.spec_from_file_location("predictor",package/"__init__.py",submodule_search_locations=[str(package)])
module=importlib.util.module_from_spec(spec);sys.modules["predictor"]=module;spec.loader.exec_module(module)
from predictor.storage import ArtifactStore
store=ArtifactStore(Path(sys.argv[2]),"owner-1","launcher-1")
with store.transaction():
    store.lease("model-forward",1,"other-process")
    print("locked",flush=True)
    input()
print("released",flush=True)
input()
'''
    process = subprocess.Popen([sys.executable, "-u", "-c", script, str(Path(__file__).parents[1] / "app"), str(tmp_path)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == "locked"
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(call, worker, "model.delete", modelId="model-forward")
            with pytest.raises(TimeoutError):
                pending.result(timeout=.2)
            process.stdin.write("release\n")
            process.stdin.flush()
            assert process.stdout.readline().strip() == "released"
            with pytest.raises(PredictionError, match="Release"):
                pending.result(timeout=5)
        assert not worker.store.deleted("model-forward", 1)
        process.communicate("exit\n", timeout=5)
        assert process.returncode == 0
        call(worker, "model.delete", modelId="model-forward")
        assert worker.store.deleted("model-forward", 1)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


@pytest.mark.parametrize("existing", [False, True])
def test_explicit_import_retries_orphan_without_publishing_it_during_inspection(tmp_path, monkeypatch, existing):
    worker = runtime(tmp_path)
    source = worker.store.namespace / "imports" / "recover"
    source.mkdir(parents=True)
    manifest = dataset()
    def stage_source():
        raw = encode_json(manifest)
        (source / "dataset.json").write_bytes(raw)
        (source / "manifest.json").write_bytes(encode_json({"kind": "caemble.prediction.dataset.artifact", "version": 1,
            "identity": manifest["datasetId"], "revision": manifest["revision"], "metadata": {},
            "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}))
    stage_source()
    if existing:
        call(worker, "dataset.import", importId="recover")
        manifest["revision"] = 2
        manifest["fingerprint"] = "sha256:" + "b" * 64
        manifest["measurements"] = manifest["measurements"][1:]
        stage_source()
    publish = worker.store.publish_dataset
    def interrupted(*args):
        raise OSError("simulated crash before latest pointer")
    monkeypatch.setattr(worker.store, "publish_dataset", interrupted)
    with pytest.raises(OSError, match="simulated crash"):
        call(worker, "dataset.import", importId="recover")
    visible = call(worker, "predictor.hello")["datasets"]
    assert [item["revision"] for item in visible] == ([1] if existing else [])
    manifest["revision"] += 1
    manifest["fingerprint"] = "sha256:" + "c" * 64
    manifest["measurements"] = manifest["measurements"][-1:]
    stage_source()
    monkeypatch.setattr(worker.store, "publish_dataset", publish)
    recovered = call(worker, "dataset.import", importId="recover")["dataset"]
    assert recovered["revision"] == (2 if existing else 1)
    assert recovered["sampleCount"] == 1
    assert recovered["fingerprint"] == manifest["fingerprint"]
