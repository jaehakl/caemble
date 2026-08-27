import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeBinaryFrame } from '../dist/binary.js';
import { GpStationJobPeer } from '../dist/job-peer.js';

class FakePeerConnection {
  signalingState = 'stable';
  iceGatheringState = 'complete';
  iceConnectionState = 'connected';
  connectionState = 'connected';

  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }
}

class FakeDataChannel {
  binaryType = 'arraybuffer';
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = [];
  listeners = new Map();

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }

  removeEventListener(name, callback) {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((item) => item !== callback),
    );
  }

  send(value) {
    this.sent.push(value);
  }

  emit(name, event = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }
}

function setup() {
  const peerConnection = new FakePeerConnection();
  const dataChannel = new FakeDataChannel();
  const diagnostics = [];
  const peer = new GpStationJobPeer(peerConnection, dataChannel, (event) => diagnostics.push(event));
  return { peer, dataChannel, diagnostics };
}

function emitControl(dataChannel, value) {
  dataChannel.emit('message', { data: JSON.stringify(value) });
}

function emitChunk(dataChannel, callId, attachmentId, index, final, body) {
  dataChannel.emit('message', {
    data: encodeBinaryFrame({ kind: 'attachment.chunk', callId, attachmentId, index, final }, body),
  });
}

function resultAcks(dataChannel) {
  return dataChannel.sent
    .filter((value) => typeof value === 'string')
    .map((value) => JSON.parse(value))
    .filter((value) => value.kind === 'job.result.ack');
}

test('inline job result keeps the public call contract', async () => {
  const { peer, dataChannel } = setup();
  const call = peer.call('call-1', 'example', {}, 1_000);

  emitControl(dataChannel, {
    kind: 'job.result',
    id: 'call-1',
    type: 'example.result',
    payload: { ok: true },
    attachments: [],
  });

  assert.deepEqual(await call, { payload: { ok: true }, files: [] });
  assert.equal(resultAcks(dataChannel).length, 1);
  peer.close();
});

test('payload attachment chunks are restored in order and hidden from callers', async () => {
  const { peer, dataChannel, diagnostics } = setup();
  const call = peer.call('call-2', 'cae.simulation.next', {}, 1_000);
  const payload = { kind: 'record', values: Array.from({ length: 200 }, (_, index) => index) };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const cuts = [0, 200, 500, payloadBytes.byteLength];
  const userBytes = new TextEncoder().encode('field-bytes');
  const control = {
    kind: 'job.result',
    id: 'call-2',
    type: 'cae.simulation.next.result',
    payload: {
      kind: 'gpstation.job-result.payload-attachments',
      storage: { kind: 'attachments', ids: ['payload'], byteLength: payloadBytes.byteLength },
    },
    attachments: [
      { id: 'payload', size: payloadBytes.byteLength, mimeType: 'application/json; charset=utf-8' },
      { id: 'field', size: userBytes.byteLength, mimeType: 'application/octet-stream' },
    ],
  };
  emitControl(dataChannel, control);
  for (let index = 0; index < cuts.length - 1; index += 1) {
    emitChunk(
      dataChannel,
      'call-2',
      'payload',
      index,
      index === cuts.length - 2,
      payloadBytes.slice(cuts[index], cuts[index + 1]),
    );
  }
  emitChunk(dataChannel, 'call-2', 'field', 0, true, userBytes);

  const result = await call;
  assert.deepEqual(result.payload, payload);
  assert.deepEqual(result.files.map((file) => file.id), ['field']);
  assert.equal(await result.files[0].blob.text(), 'field-bytes');
  const diagnostic = diagnostics.find((event) => event.stage === 'job-result');
  assert.equal(diagnostic.attachmentCount, 1);
  assert.equal(diagnostic.attachmentBytes, userBytes.byteLength);
  assert.equal(diagnostic.payloadAttachmentBytes, payloadBytes.byteLength);
  assert.equal(diagnostic.controlBytes, new TextEncoder().encode(JSON.stringify(control)).byteLength);
  assert.equal(resultAcks(dataChannel).length, 1);
  peer.close();
});

for (const scenario of [
  {
    name: 'out-of-order chunk',
    attachmentId: 'field',
    index: 1,
    final: true,
    body: new TextEncoder().encode('data'),
    pattern: /unexpected attachment chunk index/,
  },
  {
    name: 'unknown attachment',
    attachmentId: 'unknown',
    index: 0,
    final: true,
    body: new TextEncoder().encode('data'),
    pattern: /unknown job result attachment id/,
  },
  {
    name: 'incomplete final chunk',
    attachmentId: 'field',
    index: 0,
    final: true,
    body: new TextEncoder().encode('dat'),
    pattern: /attachment size mismatch/,
  },
]) {
  test(`${scenario.name} is rejected without an ACK`, async () => {
    const { peer, dataChannel } = setup();
    const call = peer.call('call-error', 'example', {}, 1_000);
    emitControl(dataChannel, {
      kind: 'job.result',
      id: 'call-error',
      payload: {},
      attachments: [{ id: 'field', size: 4 }],
    });
    emitChunk(
      dataChannel,
      'call-error',
      scenario.attachmentId,
      scenario.index,
      scenario.final,
      scenario.body,
    );

    await assert.rejects(call, scenario.pattern);
    assert.equal(resultAcks(dataChannel).length, 0);
    peer.close();
  });
}

test('missing payload attachment is rejected without an ACK', async () => {
  const { peer, dataChannel } = setup();
  const call = peer.call('call-missing', 'example', {}, 1_000);
  emitControl(dataChannel, {
    kind: 'job.result',
    id: 'call-missing',
    payload: {
      kind: 'gpstation.job-result.payload-attachments',
      storage: { kind: 'attachments', ids: ['missing'], byteLength: 2 },
    },
    attachments: [],
  });

  await assert.rejects(call, /missing job result payload attachment/);
  assert.equal(resultAcks(dataChannel).length, 0);
  peer.close();
});
