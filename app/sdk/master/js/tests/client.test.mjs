import assert from 'node:assert/strict';
import test from 'node:test';
import { GpStationClient } from '../dist/client.js';

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
