import asyncio
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psutil
import pytest

from app import runtime, worker
from sdk.slave import object_storage


class Context:
    def __init__(self):
        self.messages, self.manifests, self.parts = [], {}, {}
        self.reply = None

    async def send(self, packet):
        self.messages.append(packet)
        operation = packet['type'].split('.')[-1]
        if operation == 'record':
            self.reply = {'type': 'job.record.ack', 'sequence': packet['sequence']}
            return
        if operation == 'prepare':
            manifest = packet['manifest']
            identity = manifest['sha256']
            self.manifests[identity] = manifest
        else:
            identity = packet.get('object_id') or packet['reference']['id']
            manifest = self.manifests[identity]
        reference = {'kind': 'caemble.object', 'version': 1, 'id': identity,
                     **{key: value for key, value in manifest.items() if key != 'chunks'}}
        self.reply = {'type': f'job.storage.{operation}.ack', 'reference': reference,
                      'parts': [{**part, 'url': f'{identity}/{index}'} for index, part in enumerate(manifest['chunks'])]}

    async def receive(self):
        return self.reply, []

    def transfer(self, part, data=None):
        if data is None:
            return self.parts[part['url']]
        self.parts[part['url']] = data


async def test_calculation_protocol_runs_real_node_without_browser(monkeypatch):
    source = 'export default function calculation(input) { console.log("한글"); return { dtype: "float64", data: 7 }; }'
    context = Context()
    result = await worker.evaluate({'stage': 'calculate', 'definition_hash': 'frozen', 'measurement_id': 3,
        'recorded_data': {}, 'calculations': [{'key': 'objective', 'source': source,
        'source_hash': hashlib.sha256(source.encode()).hexdigest()}]}, [], context)
    assert result['recordSequences'] == [1] and result['definition_hash'] == 'frozen'
    assert result['runtime_id'] == runtime.doctor()['runtime_id']
    assert context.messages[-1]['value']['calculations'][0]['value'] == 7
    assert context.messages[-1]['value']['calculations'][0]['logs'] == ['한글']


async def test_server_sdk_websocket_handshake_record_and_terminal_ack():
    import websockets
    from sdk.slave.server import ServerSlaveApp, run_server_job
    from sdk.protocol.packets import receive_packet, send_packet

    source = 'export default function calculation(input) { return { dtype: "float64", data: 11 }; }'
    received = []

    async def serve(socket):
        ready, _ = await receive_packet(socket.recv)
        received.append(ready)
        await send_packet(socket.send, socket.send, {'type': 'job.input', 'stage': 'calculate',
            'definition_hash': 'frozen', 'measurement_id': 4, 'recorded_data': {},
            'calculations': [{'key': 'objective', 'source': source, 'source_hash': hashlib.sha256(source.encode()).hexdigest()}]})
        while True:
            packet, attachments = await receive_packet(socket.recv)
            assert not attachments
            received.append(packet)
            if packet['type'] == 'job.record':
                await send_packet(socket.send, socket.send, {'type': 'job.record.ack', 'sequence': 1})
            elif packet['type'] == 'job.complete':
                await send_packet(socket.send, socket.send, {'type': 'job.complete.ack'})
                break

    async with websockets.serve(serve, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        await run_server_job(ServerSlaveApp(worker.evaluate), {'job_id': 'evaluation', 'attempt_count': 1,
            'token': 'attempt-only', 'websocket_url': f'ws://127.0.0.1:{port}'})
    assert received[0]['type'] == 'job.ready'
    assert [item for item in received if item['type'] == 'job.record'][0]['value']['calculations'][0]['value'] == 11
    assert received[-1]['type'] == 'job.complete'
    assert received[-1]['definition_hash'] == 'frozen'


async def test_build_upload_projection_and_ack(monkeypatch):
    context = Context()
    monkeypatch.setattr(object_storage, 'transfer_part', context.transfer)
    program = {'pythonSource': 'a' * 70000}
    built = {'measurement': {'experiment': {'scene': {'large': 'g' * 70000}, 'taskScenes': {'heat': {}},
             'simulationProgram': program, 'varsSchema': {'size': {'shape': [], 'min': 1, 'max': 2}}},
             'materialSnapshot': {'values': list(range(20000))}}, 'presentation': {}}
    run = AsyncMock(return_value=built)
    monkeypatch.setattr(worker, 'run_node', run)
    monkeypatch.setattr(worker, 'doctor', lambda: {'runtime_id': 'build'})
    done = await worker.evaluate({'stage': 'build', 'definition_hash': 'd', 'runtime_id': 'build',
                                 'build': {'mode': 'candidate'}, 'token': 'never-forward'}, [], context)
    value = context.messages[-1]['value']
    assert value['input']['kind'] == 'caemble.object'
    projected = value['projection']['measurement']
    assert projected['experiment']['scene'] == {}
    assert projected['experiment']['taskScenes'] == {'heat': {}}
    assert projected['experiment']['simulationProgram']['pythonSource'] == program['pythonSource']
    assert projected['materialSnapshot']['values']['kind'] == 'caemble.object'
    assert 'token' not in run.call_args.args[0]
    assert done['recordSequences'] == [1]


async def test_wrong_ack_and_runtime_never_complete(monkeypatch):
    monkeypatch.setattr(worker, 'doctor', lambda: {'runtime_id': 'actual'})
    run = AsyncMock(return_value={'calculations': []})
    monkeypatch.setattr(worker, 'run_node', run)
    message = {'stage': 'calculate', 'definition_hash': 'd', 'measurement_id': 1, 'recorded_data': {}, 'calculations': []}
    with pytest.raises(ValueError, match='runtime'):
        await worker.evaluate({**message, 'runtime_id': 'old'}, [], Context())
    run.assert_not_awaited()
    context = SimpleNamespace(send=AsyncMock(), receive=AsyncMock(return_value=({'type': 'job.record.ack', 'sequence': 2}, [])))
    with pytest.raises(ValueError, match='acknowledgement'):
        await worker.evaluate(message, [], context)


async def test_hydrates_binary_object_and_rejects_corruption(monkeypatch):
    context = Context()
    monkeypatch.setattr(object_storage, 'transfer_part', context.transfer)
    reference = await object_storage.upload_object(context, b'\x00\x01\x02', 'base64')
    assert await object_storage.resolve_input(context, {'data': reference}) == {'data': 'AAEC'}
    context.parts[f'{reference["id"]}/0'] = b'bad'
    with pytest.raises(ValueError, match='hash'):
        await object_storage.read_object(context, reference)


async def test_child_never_inherits_credentials_or_injection_options(tmp_path, monkeypatch):
    for name in ('CAEMBLE_API_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'PYTHONPATH', 'CAEMBLE_EXECUTION_JSON'):
        monkeypatch.setenv(name, 'secret')
    script = tmp_path / 'env.cjs'
    script.write_text("let raw=''; process.stdin.on('data', x=>raw+=x); process.stdin.on('end',()=>{"
        "require('fs').writeFileSync(JSON.parse(raw).output_file,JSON.stringify(process.env));"
        "process.stdout.write('{\"ok\":true}');});", encoding='utf-8')
    result = await runtime.run_node({}, {'node': runtime.shutil.which('node'), 'worker': str(script)})
    assert not any(name in result for name in ('CAEMBLE_API_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'PYTHONPATH', 'CAEMBLE_EXECUTION_JSON'))


@pytest.mark.parametrize('cancel', [False, True])
async def test_timeout_or_cancel_reaps_node(tmp_path, cancel):
    pid_file = tmp_path / 'pid'
    script = tmp_path / 'hang.cjs'
    script.write_text(f"require('fs').writeFileSync({json.dumps(str(pid_file))},String(process.pid));setInterval(()=>{{}},1000);", encoding='utf-8')
    task = asyncio.create_task(runtime.run_node({}, {'node': runtime.shutil.which('node'), 'worker': str(script)}, timeout=0.5))
    for _ in range(100):
        if pid_file.exists():
            break
        await asyncio.sleep(.01)
    assert pid_file.exists()
    pid = int(pid_file.read_text())
    if cancel:
        task.cancel()
    with pytest.raises(asyncio.CancelledError if cancel else runtime.EvaluationError):
        await task
    assert not psutil.pid_exists(pid)


def test_doctor_requires_node_version_and_runtime_assets(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime.shutil, 'which', lambda _: 'node')
    monkeypatch.setattr(runtime.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='v22.0.0'))
    with pytest.raises(RuntimeError, match='24.14'):
        runtime.doctor(tmp_path)
    monkeypatch.setattr(runtime.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='v24.14.0'))
    with pytest.raises(RuntimeError, match='bundle'):
        runtime.doctor(tmp_path)
    directory = tmp_path / 'dist'
    directory.mkdir()
    (directory / 'build-info.json').write_text('{"version":"1","inputs":{}}')
    for name in ('evaluation.cjs', 'caemble-core.d.ts', 'cad-jsx.d.ts', 'lib.es5.d.ts'):
        (directory / name).touch()
    assert runtime.doctor(tmp_path)['ready'] is True
