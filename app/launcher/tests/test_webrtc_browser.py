"""Opt-in real Chromium <-> launcher subprocess WebRTC lifecycle acceptance."""
import os

import pytest

from app.slave_registry import SlaveApp
from webrtc_harness import APP_ROOT, WebRtcHarness


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_WEBRTC_BROWSER_TESTS") != "1", reason="Set RUN_WEBRTC_BROWSER_TESTS=1 for real browser tests")
async def test_browser_calls_restart_and_cancel_real_launcher_processes(tmp_path, monkeypatch):
    executable = APP_ROOT.parent / "shared/sdk/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not executable.is_file():
        pytest.fail("Install SDK [slave] dependencies in shared/sdk/.venv before this acceptance test.")
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: executable))
    (tmp_path / "fixture_worker.py").write_text(
        "import asyncio,os\nfrom sdk.slave import SlaveApp,run_app\n"
        "from sdk.protocol.messages import DataChannelMessage\n"
        "app=SlaveApp()\n"
        "@app.handler('fixture.echo')\n"
        "async def echo(message,memory,context):\n"
        " return DataChannelMessage(id=message.id,type='echo.result',payload={'pid':os.getpid(),'input':message.payload},attachments=message.attachments)\n"
        "@app.handler('fixture.wait')\n"
        "async def wait(message,memory,context):\n"
        " await context.emit_event('waiting')\n"
        " await asyncio.Event().wait()\n"
        "run_app(app)\n", encoding="utf-8")
    scenario = """
      async function cleaned(jobId) {
        for (let attempt=0; attempt<200; attempt++) {
          const state=await (await fetch('/fixture/jobs/'+jobId)).json();
          if(state.cleaned) return state;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('launcher did not confirm process cleanup');
      }
      const options={slaveAppId:'fixture',targetLauncherId:launcherId,autoFinish:false,timeoutMs:30000};
      const first=await client.runJob('fixture.echo',{text:'첫 번째'}, options);
      const binary=new Uint8Array(100000).fill(37);
      const response=await first.session.call('fixture.echo',{text:'attachment'}, {
        attachments:[{id:'binary',blob:new Blob([binary])}]
      });
      if(response.files.length!==1 || response.files[0].blob.size!==binary.length) throw new Error('attachment mismatch');
      const returned=new Uint8Array(await response.files[0].blob.arrayBuffer());
      if(returned.some(value=>value!==37)) throw new Error('attachment content mismatch');
      await first.session.finish();
      await cleaned(first.session.jobId);
      const second=await client.runJob('fixture.echo',{text:'restart'},options);
      if(second.payload.pid===first.payload.pid) throw new Error('worker process was reused');
      if(second.session.execution.attempt_id===first.session.execution.attempt_id) throw new Error('attempt identity reused');
      const waiting=second.session.call('fixture.wait',{}).then(()=>false,()=>true);
      await client.cancelJob(second.session.jobId);
      second.session.close();
      if(!await waiting) throw new Error('cancel did not reject pending request');
      await cleaned(second.session.jobId);
      const third=await client.runJob('fixture.echo',{text:'disconnect'},options);
      let entered;
      const started=new Promise(resolve=>entered=resolve);
      const disconnected=third.session.call('fixture.wait',{}, {onEvent:event=>{
        if(event.type==='waiting') entered();
      }}).then(()=>false,()=>true);
      await started;
      third.session.close();
      if(!await disconnected) throw new Error('disconnect did not reject pending request');
      const abandoned=await cleaned(third.session.jobId);
      if(abandoned.state!=='failed') throw new Error('disconnect was not reported as failed');
      client.clearPrewarmedJobConnections();
      return {firstPid:first.payload.pid,secondPid:second.payload.pid,attachmentBytes:returned.length};
    """
    slave = SlaveApp("fixture", "WebRTC fixture", "fixture_worker", tmp_path)
    async with WebRtcHarness(slave, tmp_path, scenario) as fixture:
        result = await fixture.run_browser()
        assert result["firstPid"] != result["secondPid"]
        assert result["attachmentBytes"] == 100000
        assert not fixture.manager.instances
        assert not fixture.manager.ledger.reservations
