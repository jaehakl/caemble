import assert from 'node:assert/strict';
import test from 'node:test';
import { GpStationClient } from '../dist/client.js';

for (const authMode of ['cookie', 'bearer', undefined]) {
  test(`listLaunchers uses ${authMode ?? 'default bearer'} authentication and endpoint`, async (context) => {
    const launchers = [{ id: 'fixture-launcher', slave_app_ids: ['predictor'] }];
    context.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, `http://localhost/api/${authMode === 'cookie' ? 'web' : 'v1'}/launchers`);
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(init.credentials, authMode === 'cookie' ? 'include' : undefined);
      assert.equal(init.headers.get('Authorization'), authMode === 'cookie' ? null : 'Bearer fixture');
      return Response.json(launchers);
    });
    const client = new GpStationClient({ apiBaseUrl: 'http://localhost/api/', authMode, token: 'fixture' });
    assert.deepEqual(await client.listLaunchers(), launchers);
    assert.equal(globalThis.fetch.mock.calls.length, 1);
  });
}

class OfferPeer extends EventTarget {
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  signalingState = 'stable';
  createDataChannel() { return Object.assign(new EventTarget(), { readyState: 'connecting', bufferedAmount: 0 }); }
  async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  close() { this.signalingState = 'closed'; }
}

test('target launcher is sent on initial connection and the pre-input retry', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.target_launcher_id, 'chosen-launcher');
    assert.equal(body.slave_app_id, 'predictor');
    assert.deepEqual(body.resources, { cpu_cores: 1 });
    return new Response('fixture stops after serialization', { status: 503 });
  });
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = OfferPeer;
  const client = new GpStationClient({ apiBaseUrl: 'http://localhost', token: 'fixture' });
  try {
    await assert.rejects(client.runJob('predictor.open', {}, {
      slaveAppId: 'predictor', targetLauncherId: 'chosen-launcher', resources: { cpu_cores: 1 }, autoFinish: false,
    }), /503/);
    assert.equal(globalThis.fetch.mock.calls.length, 2);
  } finally {
    globalThis.RTCPeerConnection = previous;
    client.clearPrewarmedJobConnections();
  }
});

test('public cancel uses the configured authenticated job endpoint', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://localhost/custom/jobs/job%2Fid/kill');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('Authorization'), 'Bearer fixture');
    return Response.json({ ok: true });
  });
  const client = new GpStationClient({ apiBaseUrl: 'http://localhost', token: 'fixture', jobApiPrefix: '/custom/jobs' });
  await client.cancelJob('job/id');
});

test('aborting connection HTTP stops the request without a pre-input retry', async (context) => {
  const abort = new AbortController();
  let requested;
  const ready = new Promise((resolve) => { requested = resolve; });
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    requested();
    assert.equal(init.signal, abort.signal);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = OfferPeer;
  const client = new GpStationClient({ apiBaseUrl: 'http://localhost', token: 'fixture' });
  try {
    const pending = client.runJob('predictor.hello', {}, { autoFinish: false, signal: abort.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready;
    abort.abort();
    await rejected;
    assert.equal(globalThis.fetch.mock.calls.length, 1);
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});

test('a job created after cancellation is cleaned up without starting another attempt', async (context) => {
  const abort = new AbortController();
  let requested;
  let created;
  const ready = new Promise((resolve) => { requested = resolve; });
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/late-job/kill')) {
      assert.equal(init.method, 'POST');
      return Response.json({ ok: true });
    }
    requested();
    // A reply already in transit may arrive after the HTTP signal was aborted.
    return new Promise((resolve) => { created = resolve; });
  });
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = OfferPeer;
  const client = new GpStationClient({ apiBaseUrl: 'http://localhost', token: 'fixture' });
  try {
    const pending = client.runJob('predictor.hello', {}, { autoFinish: false, signal: abort.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready;
    abort.abort();
    created(Response.json({ job: { id: 'late-job' } }));
    await rejected;
    assert.equal(globalThis.fetch.mock.calls.length, 2);
    assert.equal(globalThis.fetch.mock.calls[1].arguments[0], 'http://localhost/v1/jobs/late-job/kill');
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
