import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeBinaryFrame } from '../dist/binary.js';
import { GpStationClient, GpStationJobSession } from '../dist/client.js';
import { GpStationJobPeer } from '../dist/job-peer.js';

class FakePeer {
  closed = false;

  async call(_callId, _handlerType, _input, _timeoutMs, onEvent) {
    onEvent({ id: 'job-1', type: 'ai.chat.delta', payload: { delta: '안녕' } });
    return { type: 'ai.chat.result', payload: { answer: '안녕' } };
  }

  async finish() {}

  close() {
    this.closed = true;
  }
}

class FakePeerConnection {
  signalingState = 'stable';
  iceGatheringState = 'complete';
  iceConnectionState = 'connected';
  connectionState = 'connected';
  sctp = { maxMessageSize: 65_536 };
  closed = false;

  close() {
    this.closed = true;
    this.signalingState = 'closed';
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
  }
}

class FakeDataChannel extends EventTarget {
  binaryType = 'arraybuffer';
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = [];

  send(data) {
    this.sent.push(data);
  }

  dispatchMessage(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

function createJobPeer() {
  const peerConnection = new FakePeerConnection();
  const dataChannel = new FakeDataChannel();
  const diagnostics = [];
  const peer = new GpStationJobPeer(peerConnection, dataChannel, (event) => diagnostics.push(event));
  return { dataChannel, diagnostics, peer, peerConnection };
}

async function waitForSentMessages(dataChannel, count) {
  for (let attempt = 0; attempt < 50 && dataChannel.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(dataChannel.sent.length >= count, `expected at least ${count} sent messages`);
}

function decodeSentBinaryFrame(rawFrame) {
  const frame = new Uint8Array(rawFrame);
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(4, 4 + headerLength)));
  return { header, body: frame.slice(4 + headerLength) };
}

test('session call dispatches the same default and call onEvent once', async () => {
  const events = [];
  const onEvent = (event) => events.push(event);
  const session = new GpStationJobSession('job-1', new FakePeer(), 1000, onEvent);

  await session.call('ai.chat', { prompt: 'hello' }, { onEvent });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 'job-1', type: 'ai.chat.delta', payload: { delta: '안녕' } });
});

test('session call dispatches distinct default and call onEvent callbacks', async () => {
  const defaultEvents = [];
  const callEvents = [];
  const session = new GpStationJobSession(
    'job-1',
    new FakePeer(),
    1000,
    (event) => defaultEvents.push(event),
  );

  await session.call('ai.chat', { prompt: 'hello' }, { onEvent: (event) => callEvents.push(event) });

  assert.equal(defaultEvents.length, 1);
  assert.equal(callEvents.length, 1);
});

test('cookie auth requests include credentials without authorization header', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    });

    await client.listLaunchers();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/launchers');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'), false);
});

test('cookie auth refreshes once and retries after unauthorized response', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let csrfRequests = 0;
  let jobRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://api.example.test/web/auth/csrf') {
      csrfRequests += 1;
      return new Response(JSON.stringify({ csrf_token: `csrf-${csrfRequests}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://api.example.test/auth/refresh') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    jobRequests += 1;
    return new Response(JSON.stringify(jobRequests === 1 ? { detail: 'Not authenticated' } : []), {
      status: jobRequests === 1 ? 401 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    });

    await client.request('/web/jobs', { method: 'POST', body: '{}' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.example.test/web/auth/csrf',
      'https://api.example.test/web/jobs',
      'https://api.example.test/auth/refresh',
      'https://api.example.test/web/auth/csrf',
      'https://api.example.test/web/jobs',
    ],
  );
  assert.ok(calls.every((call) => call.init.credentials === 'include'));
  assert.ok(calls.every((call) => !new Headers(call.init.headers).has('Authorization')));
  assert.equal(new Headers(calls[1].init.headers).get('X-CSRF-Token'), 'csrf-1');
  assert.equal(new Headers(calls[4].init.headers).get('X-CSRF-Token'), 'csrf-2');
});

test('cookie auth does not retry refresh or repeat an unauthorized request indefinitely', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let refreshRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://api.example.test/auth/refresh') {
      refreshRequests += 1;
      return new Response(JSON.stringify(refreshRequests === 1 ? { ok: true } : { detail: 'Not authenticated' }), {
        status: refreshRequests === 1 ? 200 : 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ detail: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    });

    await assert.rejects(client.request('/web/jobs'), /401/);
    await assert.rejects(client.request('/auth/refresh'), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.example.test/web/jobs',
      'https://api.example.test/auth/refresh',
      'https://api.example.test/web/jobs',
      'https://api.example.test/auth/refresh',
    ],
  );
});

test('bearer auth does not refresh after unauthorized response', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ detail: 'Invalid AccessKey' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      token: 'client-token',
    });

    await assert.rejects(client.listLaunchers(), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/launchers');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer client-token');
});

test('cookie auth unsafe web requests include csrf token', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://api.example.test/web/auth/csrf') {
      return new Response(JSON.stringify({ csrf_token: 'csrf-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    });

    await client.request('/web/jobs', { method: 'POST', body: '{}' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example.test/web/auth/csrf');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].url, 'https://api.example.test/web/jobs');
  assert.equal(calls[1].init.credentials, 'include');
  const headers = new Headers(calls[1].init.headers);
  assert.equal(headers.get('X-CSRF-Token'), 'csrf-1');
  assert.equal(headers.has('Authorization'), false);
});

test('cookie auth csrf token refreshes once after forbidden response', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let csrfCounter = 0;
  let postCounter = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://api.example.test/web/auth/csrf') {
      csrfCounter += 1;
      return new Response(JSON.stringify({ csrf_token: `csrf-${csrfCounter}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    postCounter += 1;
    if (postCounter === 1) {
      return new Response(JSON.stringify({ detail: 'CSRF token required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new GpStationClient({
      apiBaseUrl: 'https://api.example.test/',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    });

    await client.request('/web/jobs/job-1/kill', { method: 'POST' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.example.test/web/auth/csrf',
      'https://api.example.test/web/jobs/job-1/kill',
      'https://api.example.test/web/auth/csrf',
      'https://api.example.test/web/jobs/job-1/kill',
    ],
  );
  assert.equal(new Headers(calls[1].init.headers).get('X-CSRF-Token'), 'csrf-1');
  assert.equal(new Headers(calls[3].init.headers).get('X-CSRF-Token'), 'csrf-2');
});

test('job peer finish resolves after job.finished ack', async () => {
  const { dataChannel, diagnostics, peer, peerConnection } = createJobPeer();

  const finished = peer.finish('job-1', 1000);
  dataChannel.dispatchMessage(JSON.stringify({ kind: 'job.finished', id: 'job-1' }));
  await finished;

  assert.deepEqual(JSON.parse(dataChannel.sent[0]), { kind: 'job.finish', id: 'job-1' });
  assert.equal(peerConnection.closed, true);
  assert.equal(diagnostics.at(-1).message, 'received job finished');
});

test('job peer finish resolves when data channel closes after finish frame is sent', async () => {
  const { dataChannel, diagnostics, peer, peerConnection } = createJobPeer();

  const finished = peer.finish('job-1', 1000);
  dataChannel.dispatchEvent(new Event('close'));
  await finished;

  assert.deepEqual(JSON.parse(dataChannel.sent[0]), { kind: 'job.finish', id: 'job-1' });
  assert.equal(peerConnection.closed, true);
  assert.equal(diagnostics.at(-1).message, 'job finish completed after data channel closed');
});

test('job peer finish resolves when data channel errors after finish frame is sent', async () => {
  const { dataChannel, diagnostics, peer, peerConnection } = createJobPeer();

  const finished = peer.finish('job-1', 1000);
  dataChannel.dispatchEvent(new Event('error'));
  await finished;

  assert.deepEqual(JSON.parse(dataChannel.sent[0]), { kind: 'job.finish', id: 'job-1' });
  assert.equal(peerConnection.closed, true);
  assert.equal(diagnostics.at(-1).message, 'job finish completed after data channel closed');
});

test('job peer call rejects when data channel errors before result', async () => {
  const { dataChannel, peer } = createJobPeer();

  const result = peer.call('job-1', 'ai.chat', { prompt: 'hello' }, 1000);
  dataChannel.dispatchEvent(new Event('error'));

  await assert.rejects(result, /data channel error/);
});

test('job peer enqueues result ack and resolves without waiting for the ack send buffer to drain', async () => {
  const { dataChannel, diagnostics, peer } = createJobPeer();
  const result = peer.call('call-1', 'cae.simulation.next', { runId: 'run-1' }, 100);
  await waitForSentMessages(dataChannel, 1);
  dataChannel.bufferedAmount = 4096;

  dataChannel.dispatchMessage(
    JSON.stringify({
      kind: 'job.result',
      id: 'call-1',
      payload: { kind: 'complete' },
      attachments: [],
    }),
  );

  assert.deepEqual(await result, { payload: { kind: 'complete' }, files: [] });
  assert.deepEqual(JSON.parse(dataChannel.sent.at(-1)), {
    kind: 'job.result.ack',
    id: 'call-1',
  });
  assert.deepEqual(
    diagnostics
      .filter(({ stage }) => stage === 'job-result' || stage === 'job-result-ack')
      .map(({ stage, callId, attachmentCount, attachmentBytes, bufferedAmount }) => ({
        stage,
        callId,
        attachmentCount,
        attachmentBytes,
        bufferedAmount,
      })),
    [
      {
        stage: 'job-result',
        callId: 'call-1',
        attachmentCount: 0,
        attachmentBytes: 0,
        bufferedAmount: 4096,
      },
      {
        stage: 'job-result-ack',
        callId: 'call-1',
        attachmentCount: 0,
        attachmentBytes: 0,
        bufferedAmount: 4096,
      },
    ],
  );
});

test('job peer acknowledges an attachment result only after the complete attachment arrives', async () => {
  const { dataChannel, diagnostics, peer } = createJobPeer();
  const result = peer.call('call-attachment', 'cae.simulation.next', { runId: 'run-1' }, 1000);
  await waitForSentMessages(dataChannel, 1);

  dataChannel.dispatchMessage(
    JSON.stringify({
      kind: 'job.result',
      id: 'call-attachment',
      payload: { kind: 'record' },
      attachments: [{ id: 'rays', name: 'rays.bin', mimeType: 'application/octet-stream', size: 3 }],
    }),
  );
  assert.equal(dataChannel.sent.length, 1);
  dataChannel.dispatchMessage(
    encodeBinaryFrame(
      {
        kind: 'attachment.chunk',
        callId: 'call-attachment',
        attachmentId: 'rays',
        index: 0,
        final: true,
      },
      new Uint8Array([1, 2, 3]),
    ),
  );

  const response = await result;
  assert.deepEqual(new Uint8Array(await response.files[0].blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(JSON.parse(dataChannel.sent.at(-1)), { kind: 'job.result.ack', id: 'call-attachment' });
  assert.deepEqual(
    diagnostics
      .filter(({ stage }) => stage === 'job-result-ack')
      .map(({ callId, attachmentCount, attachmentBytes }) => ({ callId, attachmentCount, attachmentBytes })),
    [{ callId: 'call-attachment', attachmentCount: 1, attachmentBytes: 3 }],
  );
});

test('job peer call rejects a control frame above the negotiated DataChannel message size before send', async () => {
  const { dataChannel, peer } = createJobPeer();

  await assert.rejects(
    peer.call('job-1', 'cae.simulation.start', { source: 'x'.repeat(65_536) }, 1000),
    /job call frame is \d+ bytes; negotiated RTCDataChannel max-message-size is 65536 bytes/,
  );
  assert.equal(dataChannel.sent.length, 0);
});

test('job peer call sends request attachment metadata and ordered binary chunks', async () => {
  const { dataChannel, peer } = createJobPeer();
  const data = new Uint8Array(16 * 1024 + 3);
  data.forEach((_value, index) => {
    data[index] = index % 251;
  });

  const result = peer.call(
    'job-1',
    'ai.sdxl.i2i',
    { prompts: ['hello'] },
    1000,
    undefined,
    [{ id: 'image', blob: new Blob([data], { type: 'image/png' }), name: 'input.png' }],
  );
  await waitForSentMessages(dataChannel, 3);

  assert.deepEqual(JSON.parse(dataChannel.sent[0]), {
    kind: 'job.call',
    id: 'job-1',
    type: 'ai.sdxl.i2i',
    payload: { prompts: ['hello'] },
    attachments: [{ id: 'image', name: 'input.png', mimeType: 'image/png', size: data.byteLength }],
  });
  const chunks = dataChannel.sent.slice(1, 3).map(decodeSentBinaryFrame);
  assert.deepEqual(
    chunks.map(({ header }) => header),
    [
      { kind: 'attachment.chunk', callId: 'job-1', attachmentId: 'image', index: 0, final: false },
      { kind: 'attachment.chunk', callId: 'job-1', attachmentId: 'image', index: 1, final: true },
    ],
  );
  assert.deepEqual(
    new Uint8Array([...chunks[0].body, ...chunks[1].body]),
    data,
  );

  dataChannel.dispatchMessage(JSON.stringify({ kind: 'job.result', id: 'job-1', payload: { ok: true } }));
  assert.deepEqual(await result, { payload: { ok: true }, files: [] });
});

test('job peer call waits for request attachment backpressure', async () => {
  const { dataChannel, peer } = createJobPeer();
  dataChannel.bufferedAmount = 512 * 1024 + 1;

  const result = peer.call(
    'job-1',
    'ai.sdxl.i2i',
    {},
    1000,
    undefined,
    [{ id: 'image', blob: new Blob([new Uint8Array([1])], { type: 'image/png' }) }],
  );
  await waitForSentMessages(dataChannel, 2);
  assert.equal(dataChannel.bufferedAmountLowThreshold, 128 * 1024);

  dataChannel.bufferedAmount = 0;
  dataChannel.dispatchEvent(new Event('bufferedamountlow'));
  dataChannel.dispatchMessage(JSON.stringify({ kind: 'job.result', id: 'job-1', payload: null }));
  assert.deepEqual(await result, { payload: null, files: [] });
});

test('job peer call rejects duplicate request attachment ids before sending', async () => {
  const { dataChannel, peer } = createJobPeer();
  const blob = new Blob([new Uint8Array([1])]);

  await assert.rejects(
    peer.call('job-1', 'ai.sdxl.inpaint', {}, 1000, undefined, [
      { id: 'image', blob },
      { id: 'image', blob },
    ]),
    /duplicate request attachment id/,
  );
  assert.equal(dataChannel.sent.length, 0);
});
