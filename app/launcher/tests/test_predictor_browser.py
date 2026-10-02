"""Real Chromium inference/portability using a saved numerical model fixture.

Independent training submission and publication are covered by the API/worker
training tests. These cases exercise the production WebRTC load/predict lifecycle.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import copy
import asyncio
import shutil
import subprocess
from urllib.request import Request, urlopen

import psutil
import pytest

from app.slave_registry import SlaveApp
from webrtc_harness import APP_ROOT, WebRtcHarness


async def save_model_fixture(slave, fixture, payload):
    script = """
import json, sys
from pathlib import Path
from app.runtime import PredictorRuntime
from app.models import ModelBundle
value = json.load(sys.stdin)
runtime = PredictorRuntime(Path(value['root']), value['owner'], value['launcher'], value['api'])
dataset = runtime.reader.load(value['dataset'], definition=value['definition'])
bundle = ModelBundle.prepare(dataset, 'forward', value['definition'], value['model'], runtime._model_context())
try:
    print(json.dumps(bundle.save(runtime.store)))
finally:
    bundle.close()
"""
    process = await asyncio.create_subprocess_exec(str(slave.python_executable), "-c", script,
        cwd=slave.project_dir, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    request = {**payload, "root": str(fixture.manager.settings.predictor_storage_root),
               "owner": fixture.owner_id, "launcher": fixture.launcher_id, "api": fixture.url}
    output, error = await asyncio.wait_for(process.communicate(json.dumps(request).encode("utf-8")), timeout=30)
    assert process.returncode == 0, error.decode("utf-8", errors="replace")
    return json.loads(output)


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_WEBRTC_BROWSER_TESTS") != "1", reason="Set RUN_WEBRTC_BROWSER_TESTS=1 for real browser tests")
async def test_predictor_browser_loads_and_reloads_after_process_and_dataset_removal(tmp_path):
    directory = APP_ROOT / "slaves/cae_prediction"
    slave = SlaveApp("predictor", "Predictor", "app", directory)
    if not slave.python_executable.is_file():
        pytest.fail("Run poetry install in app/slaves/cae_prediction before this acceptance test.")
    spec = importlib.util.spec_from_file_location("predictor_fixtures", directory / "tests/fixtures.py")
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)
    manifest = fixtures.dataset()
    for rule in manifest["rules"]:
        rule["result"]["tensorOrder"] = 0
        for axis in rule["result"]["axes"][:3]:
            axis.pop("ticks", None)
    scenario = f"const definition={json.dumps(fixtures.definition(manifest))};\n" + """
      const options={slaveAppId:'predictor',targetLauncherId:launcherId,autoFinish:false,timeoutMs:30000};
      async function cleaned(jobId) {
        for(let attempt=0; attempt<200; attempt++) {
          const value=await(await fetch('/fixture/jobs/'+jobId)).json();
          if(value.cleaned) return value;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Predictor process did not clean up');
      }
      async function open() {
        const job=await client.runJob('predictor.hello',{protocolVersion:3,requestId:crypto.randomUUID()},options);
        if(job.payload.error) throw new Error(JSON.stringify(job.payload.error));
        return job;
      }
      async function call(job,action,payload={},expectedError) {
        const requestId=crypto.randomUUID();
        const response=await job.session.call(action,{...payload,protocolVersion:3,requestId,sessionId:job.payload.sessionId});
        const value=response.payload;
        if(value.requestId!==requestId || value.sessionId!==job.payload.sessionId) throw new Error('RPC identity mismatch');
        if(expectedError) {
          if(value.error?.code!==expectedError) throw new Error('Expected '+expectedError+': '+JSON.stringify(value));
        } else if(value.error) throw new Error(action+': '+JSON.stringify(value.error));
        return value;
      }
      const first=await open();
      const imported=await call(first,'dataset.import',{importId:'browser-fixture'});
      if(imported.dataset.sampleCount!==3 || imported.dataset.sourceKind!=='local') throw new Error('Dataset import failed');
      if(imported.dataset.datasetId==='dataset-1' || imported.dataset.origin.datasetId!=='dataset-1') throw new Error('local source identity was not rebased');
      const dataset={datasetId:imported.dataset.datasetId,revision:imported.dataset.revision,fingerprint:imported.dataset.fingerprint};
      const unchanged=await call(first,'dataset.sync',{datasetId:dataset.datasetId});
      if(unchanged.dataset.revision!==1) throw new Error('unchanged sync created a new revision');
      const input={direction:'forward',vars:{x:.5}};
      const savedResponse=await fetch('/fixture/saved-model',{method:'POST',body:JSON.stringify({dataset,definition,
        model:{modelId:'browser-forward',revision:1,operationId:'prepare-forward',name:'Forward'}})});
      if(!savedResponse.ok) throw new Error(await savedResponse.text());
      const prepared=await call(first,'model.load',{modelId:'browser-forward',revision:1});
      const initial=await call(first,'model.predict',{instance:prepared.instance,input});
      if(Math.abs(initial.output[0].values[0]-15)>1e-10) throw new Error('Forward prediction mismatch');
      await call(first,'model.release',{instance:prepared.instance});
      if((await call(first,'model.list')).models.length!==1) throw new Error('release removed saved artifacts');
      await fetch('/fixture/change-dataset-source',{method:'POST'});
      const synced=await call(first,'dataset.sync',{datasetId:dataset.datasetId});
      if(synced.dataset.datasetId!==dataset.datasetId || synced.dataset.revision!==2 || synced.dataset.sampleCount!==2) throw new Error('explicit Dataset sync failed');
      let prepareRejected=false;
      try { await call(first,'model.prepare',{}); }
      catch(error) { prepareRejected=String(error).includes('unsupported data channel message: model.prepare'); }
      if(!prepareRejected) throw new Error('WebRTC model.prepare must not start training');
      await call(first,'dataset.delete',{datasetId:dataset.datasetId});
      if((await call(first,'dataset.list')).datasets.length) throw new Error('Dataset deletion did not complete');
      await first.session.finish();
      const firstProcess=await cleaned(first.session.jobId);
      const second=await open();
      if(second.payload.sessionId===first.payload.sessionId || second.payload.storageId!==first.payload.storageId) throw new Error('process/storage identity mismatch');
      if(second.payload.datasets.length || second.payload.models.length!==1) throw new Error('persistent artifact discovery mismatch');
      await call(second,'model.predict',{instance:prepared.instance,input},'instance-invalidated');
      const loaded=await call(second,'model.load',{modelId:'browser-forward',revision:1});
      if(loaded.artifact.manifestChecksum!==prepared.artifact.manifestChecksum) throw new Error('load rebuilt the saved model');
      const prediction=await call(second,'model.predict',{instance:loaded.instance,input});
      const preview=await (await import('/prediction-ui-fixture.js')).displayAndCalculate(loaded,prediction);
      if(prediction.provenance.datasetRevision!==1 || prediction.provenance.modelRevision!==1) throw new Error('provenance lost on reload');
      await call(second,'model.delete',{modelId:'browser-forward'},'model-in-use');
      await call(second,'model.release',{instance:loaded.instance});
      await call(second,'model.delete',{modelId:'browser-forward'});
      await call(second,'model.load',{modelId:'browser-forward',revision:1},'deleted');
      await second.session.finish();
      const secondProcess=await cleaned(second.session.jobId);
      client.clearPrewarmedJobConnections();
      return {firstPid:firstProcess.pid,secondPid:secondProcess.pid,storageId:second.payload.storageId,
        forward:initial.output[0].values[0],outputs:initial.output,reloaded:prediction.output,preview};
    """
    def stage(source):
        raw = json.dumps(source, ensure_ascii=False).encode("utf-8")
        (staging / "dataset.json").write_bytes(raw)
        artifact = {"kind": "caemble.prediction.dataset.artifact", "version": 1,
                    "identity": source["datasetId"], "revision": source["revision"],
                    "metadata": {key: source[key] for key in ("datasetId", "revision", "fingerprint", "experimentId", "name")},
                    "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}
        (staging / "manifest.json").write_text(json.dumps(artifact), encoding="utf-8")

    async def change_source(method, path, _body):
        if method == "POST" and path == "/fixture/saved-model":
            return await save_model_fixture(slave, fixture, _body)
        if method != "POST" or path != "/fixture/change-dataset-source":
            return None
        updated = copy.deepcopy(manifest)
        updated.update(revision=17, fingerprint="sha256:" + "a" * 64)
        updated["measurements"] = updated["measurements"][1:]
        stage(updated)
        return {"changed": True}

    async with WebRtcHarness(slave, tmp_path, scenario, extra_request=change_source) as fixture:
        owner_hash = hashlib.sha256(fixture.owner_id.encode()).hexdigest()
        staging = tmp_path / "storage/owners" / owner_hash / "imports/browser-fixture"
        staging.mkdir(parents=True)
        stage(manifest)
        result = await fixture.run_browser(runner=APP_ROOT / "launcher/tests/prediction-browser.mjs", timeout=240)
        assert result["preview"]["calculated"] == 15
        assert result["preview"]["candidateOrigin"] == [20, 30, 40]
        assert result["preview"]["sourceKind"] == "prediction"
        assert result["preview"]["canvasCount"] >= 1
        assert result["forward"] == pytest.approx(15)
        assert result["outputs"] == result["reloaded"]
        assert result["firstPid"] != result["secondPid"]
        assert not psutil.pid_exists(result["firstPid"])
        assert not psutil.pid_exists(result["secondPid"])
        assert not fixture.manager.instances
        assert not fixture.manager.ledger.reservations


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_WEBRTC_BROWSER_TESTS") != "1", reason="Set RUN_WEBRTC_BROWSER_TESTS=1 for real browser tests")
async def test_predictor_browser_backups_restore_after_original_storage_loss(tmp_path):
    directory = APP_ROOT / "slaves/cae_prediction"
    slave = SlaveApp("predictor", "Predictor", "app", directory)
    fixtures_spec = importlib.util.spec_from_file_location("portable_fixtures", directory / "tests/fixtures.py")
    fixtures = importlib.util.module_from_spec(fixtures_spec)
    fixtures_spec.loader.exec_module(fixtures)
    transfer_spec = importlib.util.spec_from_file_location("transfer_fixture", directory / "tests/transfer_fixture.py")
    transfer_fixture = importlib.util.module_from_spec(transfer_spec)
    transfer_spec.loader.exec_module(transfer_fixture)
    source = fixtures.dataset()
    scenario = f"const definition={json.dumps(fixtures.definition(source))};\n" + """
      const options={slaveAppId:'predictor',targetLauncherId:launcherId,autoFinish:false,timeoutMs:30000,
        resources:{cpu_cores:1,startup_ram_bytes:268435456,gpu_count:0}};
      async function open() {
        const job=await client.runJob('predictor.hello',{protocolVersion:3,requestId:crypto.randomUUID()},options);
        if(job.payload.error) throw new Error(JSON.stringify(job.payload.error));
        return job;
      }
      async function call(job,action,payload={}) {
        const response=await job.session.call(action,{...payload,protocolVersion:3,requestId:crypto.randomUUID(),sessionId:job.payload.sessionId});
        if(response.payload.error) throw new Error(action+': '+JSON.stringify(response.payload.error));
        return response.payload;
      }
      async function finish(job) {
        await job.session.finish();
        for(let attempt=0;attempt<200;attempt++) {
          const state=await(await fetch('/fixture/jobs/'+job.session.jobId)).json();
          if(state.cleaned) return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Predictor cleanup not confirmed');
      }
      const first=await open();
      const imported=(await call(first,'dataset.import',{importId:'portable'})).dataset;
      const data={datasetId:imported.datasetId,revision:imported.revision,fingerprint:imported.fingerprint};
      const savedResponse=await fetch('/fixture/saved-model',{method:'POST',body:JSON.stringify({dataset:data,definition,
        model:{modelId:'portable-model',revision:1,operationId:'prepare-portable',name:'한글 온도 모델'}})});
      if(!savedResponse.ok) throw new Error(await savedResponse.text());
      const prepared=await call(first,'model.load',{modelId:'portable-model',revision:1});
      const before=await call(first,'model.predict',{instance:prepared.instance,input:{direction:'forward',vars:{x:.5}}});
      const grants=await(await fetch('/fixture/backup',{method:'POST',body:JSON.stringify({dataset:data})})).json();
      const backed=await call(first,'artifact.backup',{operationId:'backup',grant:grants.backup,includeDataset:true,
        model:{modelId:'portable-model',revision:1,manifestChecksum:prepared.artifact.manifestChecksum}});
      if(backed.receipt.state!=='complete') throw new Error('Backup not completed');
      await call(first,'model.release',{instance:prepared.instance});
      await finish(first);
      await fetch('/fixture/lose-original',{method:'POST'});
      const second=await open();
      if(second.payload.storageId===first.payload.storageId || second.payload.models.length) throw new Error('Expected a fresh target storage');
      const restore=await(await fetch('/fixture/restore',{method:'POST',body:JSON.stringify({storageId:second.payload.storageId})})).json();
      const restored=await call(second,'artifact.restore',{operationId:'restore',grant:restore.grant});
      if(restored.receipt.state!=='complete') throw new Error('Restore not registered');
      await finish(second);
      const third=await open();
      const loaded=await call(third,'model.load',{modelId:'portable-model',revision:1,manifestChecksum:prepared.artifact.manifestChecksum});
      const after=await call(third,'model.predict',{instance:loaded.instance,input:{direction:'forward',vars:{x:.5}}});
      if(loaded.artifact.manifestChecksum!==prepared.artifact.manifestChecksum) throw new Error('Artifact bytes changed');
      if(!third.payload.datasets.some(row=>row.datasetId===data.datasetId && row.revision===data.revision)) throw new Error('Dataset identity was lost');
      await call(third,'model.release',{instance:loaded.instance});
      await finish(third);
      client.clearPrewarmedJobConnections();
      return {sourceStorageId:first.payload.storageId,targetStorageId:third.payload.storageId,output:after.output,
        before:{output:before.output,provenance:before.provenance},after:{output:after.output,provenance:after.provenance}};
    """
    with transfer_fixture.TransferServer() as storage:
        async def extra_request(method, path, body):
            if method == "POST" and path == "/fixture/saved-model":
                return await save_model_fixture(slave, fixture, body)
            if path.startswith("/prediction/operations/"):
                def forward():
                    data = json.dumps(body).encode() if body is not None else None
                    with urlopen(Request(storage.url + path, data=data, method=method), timeout=30) as response:
                        return json.loads(response.read())
                return await asyncio.to_thread(forward)
            if method == "POST" and path == "/fixture/backup":
                data = body["dataset"]
                storage.operations["backup"] = {"id": "backup", "kind": "backup", "model_id": "portable-model", "model_revision": 1,
                    "include_dataset": True, "dataset_id": data["datasetId"], "dataset_revision": data["revision"],
                    "dataset_fingerprint": data["fingerprint"]}
                grant = {key: value.replace(storage.url, fixture.url) if isinstance(value, str) else value
                         for key, value in storage.grant("backup").items()}
                return {"backup": grant}
            if method == "POST" and path == "/fixture/lose-original":
                original = (tmp_path / "storage").resolve()
                assert original.is_relative_to(tmp_path.resolve()) and not fixture.manager.instances
                shutil.rmtree(original)
                fixture.manager.settings.predictor_storage_root = tmp_path / "restored"
                return {"removed": True}
            if method == "POST" and path == "/fixture/restore":
                storage.operations["restore"] = {**storage.operations["backup"], "id": "restore", "kind": "restore", "target_storage_id": body["storageId"]}
                grant = {key: value.replace(storage.url, fixture.url) if isinstance(value, str) else value
                         for key, value in storage.grant("restore").items()}
                return {"grant": grant}
            return None

        async with WebRtcHarness(slave, tmp_path, scenario, extra_request=extra_request) as fixture:
            owner_hash = hashlib.sha256(fixture.owner_id.encode()).hexdigest()
            staging = tmp_path / "storage/owners" / owner_hash / "imports/portable"
            staging.mkdir(parents=True)
            raw = json.dumps(source, ensure_ascii=False).encode("utf-8")
            (staging / "dataset.json").write_bytes(raw)
            (staging / "manifest.json").write_text(json.dumps({"kind": "caemble.prediction.dataset.artifact", "version": 1,
                "identity": source["datasetId"], "revision": source["revision"], "metadata": {},
                "files": [{"name": "dataset.json", "byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}), encoding="utf-8")
            result = await fixture.run_browser(timeout=150)
            assert result["sourceStorageId"] != result["targetStorageId"]
            assert result["before"] == result["after"]
            assert result["output"][0]["values"] == pytest.approx([15], abs=1e-12, rel=1e-12)
            assert not fixture.manager.instances
            assert not fixture.manager.ledger.reservations
