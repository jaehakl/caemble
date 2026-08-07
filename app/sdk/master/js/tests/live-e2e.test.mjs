import assert from 'node:assert/strict';
import test from 'node:test';

import { GpStationClient } from '../dist/index.js';

const API_BASE_URL_ENV = 'CAEMBLE_V1_E2E_API_BASE_URL';
const CLIENT_TOKEN_ENV = 'CAEMBLE_V1_E2E_CLIENT_TOKEN';
const TIMEOUT_SECONDS_ENV = 'CAEMBLE_V1_E2E_TIMEOUT_SECONDS';
const missingRequiredEnv = [API_BASE_URL_ENV, CLIENT_TOKEN_ENV].filter(
  (name) => !process.env[name]?.trim(),
);

test(
  'Caemble v1 bearer contract live',
  {
    skip: missingRequiredEnv.length > 0
      ? `live E2E requires ${missingRequiredEnv.join(', ')}`
      : false,
  },
  async (context) => {
    const missingBrowserGlobals = ['RTCPeerConnection', 'fetch', 'Headers', 'Blob'].filter(
      (name) => typeof globalThis[name] !== 'function',
    );
    if (missingBrowserGlobals.length > 0) {
      context.skip(`live E2E requires browser globals: ${missingBrowserGlobals.join(', ')}`);
      return;
    }

    const timeoutSeconds = Number(process.env[TIMEOUT_SECONDS_ENV]?.trim() || '300');
    assert.ok(
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0,
      `${TIMEOUT_SECONDS_ENV} must be a positive number`,
    );
    const timeoutMs = timeoutSeconds * 1000;
    const deltas = [];
    const client = new GpStationClient({
      apiBaseUrl: process.env[API_BASE_URL_ENV].trim(),
      token: process.env[CLIENT_TOKEN_ENV].trim(),
    });

    try {
      const launchers = await client.listLaunchers();
      assert.ok(
        launchers.some(
          (launcher) => launcher.slave_app_ids.includes('ai') && launcher.slave_app_ids.includes('cae'),
        ),
        `no connected launcher advertises both ai and cae; available=${JSON.stringify(
          launchers.map((launcher) => [launcher.launcher_name, launcher.slave_app_ids]),
        )}`,
      );

      const caeResult = await client.runJob(
        'cae.solvers.manifests',
        {},
        { slaveAppId: 'cae', timeoutMs },
      );
      assert.equal(caeResult.payload?.formatVersion, 1);
      assert.ok(Number.isInteger(caeResult.payload?.count) && caeResult.payload.count > 0);
      assert.ok(
        typeof caeResult.payload?.attachmentId === 'string' && caeResult.payload.attachmentId,
      );
      const manifestFile = caeResult.files.find(
        (file) => file.id === caeResult.payload.attachmentId,
      );
      assert.ok(manifestFile);
      const manifests = JSON.parse(await manifestFile.blob.text());
      assert.ok(Array.isArray(manifests));
      assert.equal(manifests.length, caeResult.payload.count);

      const modelResult = await client.runJob(
        'ai.llm.models',
        {},
        { slaveAppId: 'ai', timeoutMs },
      );
      assert.ok(
        typeof modelResult.payload?.default_model === 'string' && modelResult.payload.default_model,
      );
      assert.ok(Array.isArray(modelResult.payload?.models) && modelResult.payload.models.length > 0);
      assert.ok(
        modelResult.payload.models.some(
          (model) => model && typeof model === 'object' && model.name === modelResult.payload.default_model,
        ),
      );

      const chatResult = await client.runJob(
        'ai.chat',
        {
          model: modelResult.payload.default_model,
          system_prompt: 'Answer briefly and follow the user request.',
          prompt: 'Reply with the single word CAEMBLE.',
          max_tokens: 16,
          temperature: 0,
          think: false,
        },
        {
          slaveAppId: 'ai',
          timeoutMs,
          autoFinish: false,
          onEvent: (event) => {
            if (
              event.type === 'ai.chat.delta'
              && event.payload
              && typeof event.payload === 'object'
              && typeof event.payload.delta === 'string'
            ) {
              deltas.push(event.payload.delta);
            }
          },
        },
      );
      try {
        assert.ok(typeof chatResult.payload?.answer === 'string' && chatResult.payload.answer);
        assert.ok(deltas.length > 0);
        assert.equal(deltas.join(''), chatResult.payload.answer);
      } finally {
        try {
          await chatResult.session.finish({ timeoutMs });
        } finally {
          if (!chatResult.session.closed) {
            chatResult.session.close();
          }
        }
      }
      assert.equal(chatResult.session.closed, true);
    } finally {
      client.clearPrewarmedJobConnections();
    }
  },
);
