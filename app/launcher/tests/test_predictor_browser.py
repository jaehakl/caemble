"""Real Predictor preparation and artifact reload through Chromium WebRTC."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import copy

import psutil
import pytest

from app.slave_registry import SlaveApp
from webrtc_harness import APP_ROOT, WebRtcHarness


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_WEBRTC_BROWSER_TESTS") != "1", reason="Set RUN_WEBRTC_BROWSER_TESTS=1 for real browser tests")
async def test_predictor_browser_prepares_and_reloads_after_process_and_dataset_removal(tmp_path):
    directory = APP_ROOT / "slaves/predictor"
    slave = SlaveApp("predictor", "Predictor", "app", directory)
    if not slave.python_executable.is_file():
        pytest.fail("Run poetry install in app/slaves/predictor before this acceptance test.")
    spec = importlib.util.spec_from_file_location("predictor_fixtures", directory / "tests/fixtures.py")
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)
    manifest = fixtures.dataset()
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
        const job=await client.runJob('predictor.hello',{protocolVersion:1,requestId:crypto.randomUUID()},options);
        if(job.payload.error) throw new Error(JSON.stringify(job.payload.error));
        return job;
      }
      async function call(job,action,payload={},expectedError) {
        const requestId=crypto.randomUUID();
        const response=await job.session.call(action,{...payload,protocolVersion:1,requestId,sessionId:job.payload.sessionId});
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
      const prepared={};
      const results={};
      const reloaded={};
      const inputs={forward:{direction:'forward',vars:{x:.5}},inverse:{direction:'inverse',targets:{'4':{dtype:'float64',shape:[],axes:[],data:15}}}};
      for(const direction of ['forward','inverse']) {
        prepared[direction]=await call(first,'model.prepare',{dataset,direction,definition,
          model:{modelId:'browser-'+direction,revision:1,operationId:'prepare-'+direction,name:direction}});
        results[direction]=await call(first,'model.predict',{instance:prepared[direction].instance,input:inputs[direction]});
        const expected=direction==='forward'?15:.5;
        if(Math.abs(results[direction].output[0].values[0]-expected)>1e-10) throw new Error(direction+' prediction mismatch');
        await call(first,'model.release',{instance:prepared[direction].instance});
      }
      if((await call(first,'model.list')).models.length!==2) throw new Error('release removed saved artifacts');
      await fetch('/fixture/change-dataset-source',{method:'POST'});
      const synced=await call(first,'dataset.sync',{datasetId:dataset.datasetId});
      if(synced.dataset.datasetId!==dataset.datasetId || synced.dataset.revision!==2 || synced.dataset.sampleCount!==2) throw new Error('explicit Dataset sync failed');
      await call(first,'model.prepare',{dataset,direction:'forward',definition,
        model:{modelId:'retired-dataset',revision:1,operationId:'retired',name:'retired'}},'dataset-unavailable');
      await call(first,'dataset.delete',{datasetId:dataset.datasetId});
      if((await call(first,'dataset.list')).datasets.length) throw new Error('Dataset deletion did not complete');
      await first.session.finish();
      const firstProcess=await cleaned(first.session.jobId);
      const second=await open();
      if(second.payload.sessionId===first.payload.sessionId || second.payload.storageId!==first.payload.storageId) throw new Error('process/storage identity mismatch');
      if(second.payload.datasets.length || second.payload.models.length!==2) throw new Error('persistent artifact discovery mismatch');
      await call(second,'model.predict',{instance:prepared.forward.instance,input:inputs.forward},'instance-invalidated');
      for(const direction of ['forward','inverse']) {
        const loaded=await call(second,'model.load',{modelId:'browser-'+direction,revision:1});
        if(loaded.artifact.manifestChecksum!==prepared[direction].artifact.manifestChecksum) throw new Error('load rebuilt the saved model');
        const prediction=await call(second,'model.predict',{instance:loaded.instance,input:inputs[direction]});
        reloaded[direction]=prediction.output;
        if(prediction.provenance.datasetRevision!==1 || prediction.provenance.modelRevision!==1) throw new Error('provenance lost on reload');
        await call(second,'model.delete',{modelId:'browser-'+direction},'model-in-use');
        await call(second,'model.release',{instance:loaded.instance});
        await call(second,'model.delete',{modelId:'browser-'+direction});
        await call(second,'model.load',{modelId:'browser-'+direction,revision:1},'deleted');
      }
      await second.session.finish();
      const secondProcess=await cleaned(second.session.jobId);
      client.clearPrewarmedJobConnections();
      return {firstPid:firstProcess.pid,secondPid:secondProcess.pid,storageId:second.payload.storageId,
        forward:results.forward.output[0].values[0],inverse:results.inverse.output[0].values[0],
        outputs:{forward:results.forward.output,inverse:results.inverse.output},reloaded};
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
        result = await fixture.run_browser()
        assert result["forward"] == pytest.approx(15)
        assert result["inverse"] == pytest.approx(.5)
        assert result["outputs"] == result["reloaded"]
        assert result["firstPid"] != result["secondPid"]
        assert not psutil.pid_exists(result["firstPid"])
        assert not psutil.pid_exists(result["secondPid"])
        assert not fixture.manager.instances
        assert not fixture.manager.ledger.reservations
