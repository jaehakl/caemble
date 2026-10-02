"""Real Launcher and training process with loopback server transport, without a browser."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
from uuid import uuid4

import psutil
import pytest
import websockets

from app.slave_registry import load_registry
from sdk.protocol.packets import receive_packet, send_packet
from webrtc_harness import APP_ROOT, WebRtcHarness


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_PREDICTOR_PROCESS_TESTS") != "1",
                    reason="Set RUN_PREDICTOR_PROCESS_TESTS=1 for the real Predictor process test")
async def test_server_training_finishes_and_releases_resources_without_inference_session(tmp_path):
    slave = load_registry(APP_ROOT / "slaves").require("predictor-training")
    assert slave.python_executable.is_file(), "Run poetry install in app/slaves/predictor first."
    module = importlib.util.spec_from_file_location("training_fixtures", slave.project_dir / "tests/fixtures.py")
    fixtures = importlib.util.module_from_spec(module)
    module.loader.exec_module(fixtures)
    dataset = fixtures.dataset()
    manifest_bytes = json.dumps(dataset).encode("utf-8")
    dataset_requested, release_dataset, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    packets = []

    async def request(method, path, _body):
        if method == "GET" and path == "/prediction/datasets/dataset-1/revisions/1/manifest":
            return dataset
        if method == "GET" and path == dataset_path:
            dataset_requested.set()
            await release_dataset.wait()
            return {"grant": {"dataset_id": dataset["datasetId"], "revision": dataset["revision"],
                "fingerprint": dataset["fingerprint"], "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "manifest_url": fixture.url + "/prediction/datasets/dataset-1/revisions/1/manifest", "token": "dataset-scoped"}}
        return None

    async def serve(websocket):
        ready, _ = await receive_packet(websocket.recv)
        assert ready["type"] == "job.ready"
        assert all(ready[key] == value for key, value in identity.items())
        await send_packet(websocket.send, websocket.send, {"type": "job.input", **identity, **spec})
        while True:
            packet, attachments = await receive_packet(websocket.recv)
            assert not attachments
            packets.append(packet)
            if packet["type"] in {"job.complete", "job.failed", "job.cancelled"}:
                await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack", **identity})
                completed.set()
                await websocket.wait_closed()
                return

    async with WebRtcHarness(slave, tmp_path, "", extra_request=request) as fixture:
        identity = {"launcher_id": fixture.launcher_id, "boot_id": fixture.manager.boot_id,
            "job_id": str(uuid4()), "instance_id": str(uuid4()), "attempt_id": str(uuid4()),
            "attempt_count": 1, "reservation_id": str(uuid4())}
        dataset_path = f"/prediction/training/jobs/{identity['job_id']}/attempts/{identity['attempt_id']}/dataset"
        owner = hashlib.sha256(fixture.owner_id.encode()).hexdigest()
        namespace = tmp_path / "storage" / "owners" / owner
        # ArtifactStore creates this stable identity before the job is admitted.
        # The fixture supplies it just as the preceding management handshake does.
        namespace.mkdir(parents=True)
        storage_id = str(uuid4())
        (tmp_path / "storage/storage-id").write_text(storage_id, encoding="utf-8")
        spec = {"operationId": "server-training", "pinId": str(uuid4()), "storageId": storage_id,
            "launcherId": fixture.launcher_id, "sourceKind": "api",
            "model": {"modelId": "server-trained", "revision": 1, "operationId": "server-training", "name": "Trained"},
            "dataset": {key: dataset[key] for key in ("datasetId", "revision", "fingerprint")},
            "definition": fixtures.definition(dataset), "datasetAccessUrl": fixture.url + dataset_path}
        spec["definition"]["implementationId"] = "remote-predictor"
        reservation = {"type": "job.reserve", **identity, "slave_app_id": "predictor-training",
            "handler_type": "prediction.train", "job_mode": "websocket", "resources": {"cpu_cores": 1}}
        async with websockets.serve(serve, "127.0.0.1", 0) as server:
            await fixture.manager.reserve_job(reservation)
            worker = fixture.manager.instances[identity["instance_id"]]
            await fixture.manager.start_job({**reservation, "type": "job.start", "allocation": worker.allocation,
                "websocket_url": f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", "token": "attempt-scoped"})
            try:
                await asyncio.wait_for(dataset_requested.wait(), timeout=30)
                assert fixture.browser is None
                assert worker.process is not None and worker.process.returncode is None
                pid = worker.process.pid
                assert fixture.manager.ledger.reservations
            finally:
                release_dataset.set()
            await asyncio.wait_for(completed.wait(), timeout=30)
            assert packets[-1]["type"] == "job.complete", packets[-1]
            artifact = packets[-1]["artifact"]
            assert artifact["modelId"] == "server-trained" and artifact["storageId"] == storage_id
            assert artifact["definition"]["implementationId"] == "remote-predictor"
            assert {packet["progress"].get("stage") for packet in packets if packet["type"] == "job.progress"} >= {
                "loading-dataset", "training", "saving", "saved"}
            async with asyncio.timeout(15):
                while fixture.manager.instances:
                    await asyncio.sleep(.02)
            assert not fixture.manager.ledger.reservations
            assert not psutil.pid_exists(pid)
            assert (namespace / "models/server-trained/1/manifest.json").is_file()
