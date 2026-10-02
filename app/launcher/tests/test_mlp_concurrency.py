"""Opt-in real MLP inference beside a separately cancellable training process."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import subprocess
from uuid import uuid4

import psutil
import pytest
import websockets

from app.resources import GIB, ResourcePolicy, discover_gpus
from app.slave_registry import SlaveAppRegistry, load_registry
from sdk.protocol.packets import receive_packet, send_packet
from webrtc_harness import APP_ROOT, WebRtcHarness


async def wait_until(predicate, timeout=30):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.05)


@pytest.mark.asyncio
@pytest.mark.parametrize("gpu_count", [
    pytest.param(0, marks=pytest.mark.skipif(os.getenv("RUN_PREDICTOR_PROCESS_TESTS") != "1",
        reason="Set RUN_PREDICTOR_PROCESS_TESTS=1 for real CPU MLP concurrency")),
    pytest.param(1, marks=pytest.mark.skipif(os.getenv("RUN_PREDICTOR_CUDA_TESTS") != "1",
        reason="Set RUN_PREDICTOR_CUDA_TESTS=1 for real CUDA MLP concurrency")),
])
async def test_cancel_training_preserves_resident_mlp_inference_and_releases_its_resources(tmp_path, gpu_count):
    if len(psutil.Process().cpu_affinity()) < 2:
        pytest.skip("Concurrent Predictor processes require two available CPU cores.")
    devices = None
    if gpu_count:
        eligible = [device for device in discover_gpus() if device["free_bytes"] >= 8 * GIB]
        if not eligible:
            pytest.skip("Requires one CUDA GPU with 8 GiB free for two explicit 4 GiB profiles.")
        devices = [eligible[0]["uuid"]]
    registry = load_registry(APP_ROOT / "slaves")
    inference, training = registry.require("predictor"), registry.require("predictor-training")
    assert inference.python_executable.is_file(), "Install the Predictor environment before acceptance."
    module = importlib.util.spec_from_file_location("concurrent_mlp_fixture", inference.project_dir / "tests/fixtures.py")
    fixtures = importlib.util.module_from_spec(module)
    module.loader.exec_module(fixtures)
    dataset = fixtures.dataset()
    definition = fixtures.definition(dataset)
    definition.update(implementationId="remote-predictor", implementationVersion="mlp-v1",
        algorithm={"kind": "mlp", "hiddenLayers": [32, 32], "epochs": 500,
                   "batchSize": 32, "learningRate": .001, "seed": 0})
    resources = {"cpu_cores": 1, "startup_ram_bytes": 512 * 1024**2, "gpu_count": gpu_count,
                 **({"vram_budget_gb": 4} if gpu_count else {})}
    policy = ResourcePolicy(cpu_cores=2, gpu_count=gpu_count, gpu_devices=devices, ram_budget_gb=8,
        defaults={"predictor": resources, "predictor-training": resources})
    training_started, training_finished = asyncio.Event(), asyncio.Event()
    packets, training_pids = [], set()
    training_worker = identity = spec = dataset_path = None
    report = {"gpuCount": gpu_count, "resourcesPerProcess": resources}
    scenario = "const resources=" + json.dumps(resources) + ";\n" + """
      const job=await client.runJob('predictor.hello',{protocolVersion:3,requestId:crypto.randomUUID()},
        {slaveAppId:'predictor',targetLauncherId:launcherId,autoFinish:false,timeoutMs:45000,resources});
      if(job.payload.error) throw new Error(JSON.stringify(job.payload.error));
      async function call(action,body={}) {
        const requestId=crypto.randomUUID();
        const response=await job.session.call(action,{...body,protocolVersion:3,requestId,sessionId:job.payload.sessionId});
        if(response.payload.error) throw new Error(action+': '+JSON.stringify(response.payload.error));
        if(response.payload.requestId!==requestId) throw new Error('RPC request identity changed');
        return response.payload;
      }
      async function post(path) {
        const response=await fetch(path,{method:'POST',body:JSON.stringify({inferenceJobId:job.session.jobId})});
        if(!response.ok) throw new Error(await response.text());
        return response.json();
      }
      const loaded=await call('model.load',{modelId:'resident-mlp',revision:1});
      const input={direction:'forward',vars:{x:1}};
      const before=await call('model.predict',{instance:loaded.instance,input});
      await post('/fixture/start-concurrent-training');
      const during=await call('model.predict_batch',{instance:loaded.instance,
        inputs:[{candidateId:'one',input},{candidateId:'two',input}]});
      if(during.predictions.length!==2 || during.predictions[0].candidateId!=='one' || during.predictions[1].candidateId!=='two')
        throw new Error('Native batch lost candidate identity');
      const cancelled=await post('/fixture/cancel-concurrent-training');
      const after=await call('model.predict',{instance:loaded.instance,input});
      if(JSON.stringify(before.output)!==JSON.stringify(after.output)) throw new Error('Cancelling training changed inference');
      for(const prediction of during.predictions) {
        if(Math.abs(prediction.output[0].values[0]-before.output[0].values[0])>1e-5)
          throw new Error('Concurrent batch differs from single inference');
      }
      await call('model.release',{instance:loaded.instance});
      await job.session.finish();
      for(let attempt=0;attempt<400;attempt++) {
        const state=await(await fetch('/fixture/jobs/'+job.session.jobId)).json();
        if(state.cleaned) {
          client.clearPrewarmedJobConnections();
          return {before:before.output,after:after.output,inferencePid:state.pid,cancelled};
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('Inference cleanup was not confirmed');
    """

    async def serve(websocket):
        ready, _ = await receive_packet(websocket.recv)
        assert ready["type"] == "job.ready"
        assert all(ready[key] == value for key, value in identity.items())
        await send_packet(websocket.send, websocket.send, {"type": "job.input", **identity, **spec})
        try:
            while True:
                packet, attachments = await receive_packet(websocket.recv)
                assert not attachments
                packets.append(packet)
                if packet["type"] == "job.progress" and packet["progress"].get("metrics", {}).get("epoch", 0) > 0:
                    training_started.set()
                if packet["type"] in {"job.complete", "job.failed", "job.cancelled"}:
                    await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack", **identity})
                    training_finished.set()
                    await websocket.wait_closed()
                    return
        except websockets.ConnectionClosed:
            # Launcher cancellation can reap the process before its final transport ACK.
            training_finished.set()

    async def request(method, path, body):
        nonlocal training_worker, identity, spec, dataset_path
        if method == "GET" and path == "/prediction/datasets/dataset-1/revisions/1/manifest":
            return dataset
        if method == "GET" and path == dataset_path:
            raw = json.dumps(dataset).encode("utf-8")
            return {"grant": {"dataset_id": dataset["datasetId"], "revision": dataset["revision"],
                "fingerprint": dataset["fingerprint"], "manifest_sha256": hashlib.sha256(raw).hexdigest(),
                "manifest_url": fixture.url + "/prediction/datasets/dataset-1/revisions/1/manifest", "token": "dataset-scoped"}}
        if method != "POST" or path not in {"/fixture/start-concurrent-training", "/fixture/cancel-concurrent-training"}:
            return None
        inference_job = fixture.jobs[body["inferenceJobId"]]
        resident = fixture.manager.instances[inference_job["instance_id"]]
        assert resident.process.returncode is None
        if path == "/fixture/start-concurrent-training":
            if gpu_count:
                await wait_until(lambda: any(row["admission_open"] for row in fixture.manager.ledger.gpu_report()))
            identity = {"launcher_id": fixture.launcher_id, "boot_id": fixture.manager.boot_id,
                "job_id": str(uuid4()), "instance_id": str(uuid4()), "attempt_id": str(uuid4()),
                "attempt_count": 1, "reservation_id": str(uuid4())}
            fixture.jobs[identity["job_id"]] = {**identity, "state": "queued", "answered": asyncio.Event(), "cleaned": False}
            dataset_path = f"/prediction/training/jobs/{identity['job_id']}/attempts/{identity['attempt_id']}/dataset"
            spec = {"operationId": "cancel-concurrent-training", "pinId": str(uuid4()), "storageId": saved["storageId"],
                "launcherId": fixture.launcher_id, "sourceKind": "api",
                "model": {"modelId": "new-mlp", "revision": 1, "operationId": "cancel-concurrent-training", "name": "Cancelled"},
                "dataset": {key: dataset[key] for key in ("datasetId", "revision", "fingerprint")},
                "definition": {**definition, "fingerprint": "concurrent-training", "algorithm": {
                    **definition["algorithm"], "hiddenLayers": [256, 256, 256, 256], "epochs": 10_000, "batchSize": 1}},
                "datasetAccessUrl": fixture.url + dataset_path}
            reservation = {"type": "job.reserve", **identity, "slave_app_id": training.id,
                "handler_type": "prediction.train", "job_mode": "websocket", "resources": resources,
                "resources_resolved": True}
            await fixture.manager.reserve_job(reservation)
            assert identity["instance_id"] in fixture.manager.instances, fixture.events[-1]
            training_worker = fixture.manager.instances[identity["instance_id"]]
            await fixture.manager.start_job({**reservation, "type": "job.start", "allocation": training_worker.allocation,
                "websocket_url": socket_url, "token": "training-attempt"})
            await wait_until(lambda: training_started.is_set() or training_finished.is_set(), timeout=35)
            assert training_started.is_set() and not training_finished.is_set(), packets[-1:]
            assert len(fixture.manager.instances) == len(fixture.manager.ledger.reservations) == 2
            assert all(len(worker.allocation["gpu_devices"]) == gpu_count for worker in (resident, training_worker))
            if gpu_count:
                assert resident.allocation["gpu_devices"] == training_worker.allocation["gpu_devices"] == devices
                assert all(worker.allocation["vram_budget_bytes"] == {devices[0]: 4 * GIB} for worker in (resident, training_worker))
                await wait_until(lambda: all(worker.vram_used_bytes and worker.vram_used_bytes.get(devices[0], 0) > 0
                                            for worker in (resident, training_worker)))
                report["concurrentVramBytes"] = {worker.slave_app_id: worker.vram_used_bytes for worker in (resident, training_worker)}
            training_pids.update(training_worker.container.pids())
            report["trainingPid"] = training_worker.process.pid
            report["concurrentReservations"] = 2
            return {"trainingStarted": True}
        await fixture.manager.cancel_job({**identity, "reason": "concurrent MLP acceptance cancellation"})
        await wait_until(lambda: identity["instance_id"] not in fixture.manager.instances)
        assert not any(psutil.pid_exists(pid) for pid in training_pids)
        assert len(fixture.manager.instances) == len(fixture.manager.ledger.reservations) == 1
        assert resident.process.returncode is None
        assert training_worker.terminal["type"] == "job.cancelled"
        assert not (owner_namespace / "models/new-mlp/1/manifest.json").exists()
        assert not any(packet["type"] == "job.complete" for packet in packets)
        report["trainingCleanupVerified"] = True
        return {"cancelled": True, "remainingReservations": 1}

    async with WebRtcHarness(inference, tmp_path, scenario, extra_request=request, resource_policy=policy) as fixture:
        fixture.manager.registry = SlaveAppRegistry([inference, training])
        owner_namespace = tmp_path / "storage/owners" / hashlib.sha256(fixture.owner_id.encode()).hexdigest()
        # Prepare only the immutable seed on CPU; both concurrent jobs below use real allocated resources.
        script = """
import json,sys
from pathlib import Path
from app.runtime import PredictorRuntime
from app.models import ModelBundle
value=json.load(sys.stdin)
runtime=PredictorRuntime(Path(value['root']),value['owner'],value['launcher'],value['api'])
bundle=ModelBundle.prepare(value['dataset'],'forward',value['definition'],
    {'modelId':'resident-mlp','revision':1,'operationId':'seed-model','name':'Resident'},runtime._model_context())
try:
    print(json.dumps(bundle.save(runtime.store)))
finally:
    bundle.close()
"""
        process = await asyncio.create_subprocess_exec(str(inference.python_executable), "-c", script,
            cwd=inference.project_dir, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            output, error = await asyncio.wait_for(process.communicate(json.dumps({"root": str(tmp_path / "storage"),
                "owner": fixture.owner_id, "launcher": fixture.launcher_id, "api": fixture.url,
                "dataset": dataset, "definition": definition}).encode("utf-8")), timeout=45)
            assert process.returncode == 0, error.decode("utf-8", errors="replace")
            saved = json.loads(output)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        if gpu_count:
            await wait_until(lambda: any(row["admission_open"] for row in fixture.manager.ledger.gpu_report()))
        async with websockets.serve(serve, "127.0.0.1", 0) as server:
            socket_url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            result = await fixture.run_browser(timeout=150)
        await wait_until(lambda: not fixture.manager.instances)
        assert not fixture.manager.ledger.reservations
        assert not psutil.pid_exists(result["inferencePid"])
        assert result["before"][0]["values"] == pytest.approx([20], abs=.02)
        assert result["before"] == result["after"]
        assert report["trainingCleanupVerified"]
        report.update(inferencePid=result["inferencePid"], finalReservations=0, inferenceCleanupVerified=True)
        (tmp_path / "mlp-concurrency-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))
