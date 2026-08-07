# Caemble GPStation v1 Master JS SDK

Browser TypeScript SDK for the master side of Caemble's GPStation v1-compatible job runtime.

Build it before running the AI master app:

```powershell
cd app/sdk/master/js
npm ci
npm run build
```

```ts
import { GpStationClient } from '@gpstation/v1-master-js-sdk';

const token = window.prompt('Client-scoped Caemble access token');
if (!token) throw new Error('Access Token is required');

const client = new GpStationClient({
  apiBaseUrl: 'http://127.0.0.1:8000',
  token,
});

const launchers = await client.listLaunchers();
console.log(launchers);

const result = await client.runJob(
  'ai.llm',
  {
    system_prompt: 'Answer concisely.',
    prompt: 'hello',
    max_tokens: 128,
  },
  { slaveAppId: 'ai' },
);

console.log(result.payload);
```

Browser tokens must be supplied at runtime. Do not put them in `VITE_*`, a bundle, `localStorage`, or `sessionStorage`.

`runJob` uses a long-lived WebRTC job protocol internally. By default it sends one handler call and automatically finishes the job. To keep the DataChannel open for more calls, set `autoFinish: false` and finish the returned session explicitly:

```ts
const first = await client.runJob(
  'ai.llm',
  { system_prompt: 'Answer concisely.', prompt: 'hello' },
  { slaveAppId: 'ai', autoFinish: false },
);

const embedding = await first.session.call('ai.embeddings', {
  text: 'hello',
});

await first.session.finish();

console.log(first.payload, embedding.payload);
```

Handlers can push DataChannel-only events during a call. Use `onEvent` on `runJob` or `session.call` to render streamed progress without waiting for the final result.

Binary request attachments are sent directly over the job DataChannel. Each attachment requires a call-scoped `id`, which handlers use to assign a file role. For example, SDXL inpaint reserves `image` for the source and `mask` for the grayscale mask:

```ts
const result = await client.runJob(
  'ai.sdxl.inpaint',
  {
    prompts: ['a renovated room with warm lighting'],
    strength: 0.8,
    width: 1024,
    height: 1024,
  },
  {
    slaveAppId: 'ai',
    attachments: [
      { id: 'image', name: sourceFile.name, mimeType: sourceFile.type, blob: sourceFile },
      { id: 'mask', name: maskFile.name, mimeType: maskFile.type, blob: maskFile },
    ],
  },
);

console.log(result.payload, result.files);
```

The same `attachments` option is available on `session.call`. Request attachments are limited to 20 MiB each.

## Opt-in live contract smoke

`tests/live-e2e.test.mjs` exercises the published 0.1.0 bearer API without a
GPStation checkout or private client hooks. It constructs `GpStationClient`
with only the Caemble API base URL and a client-scoped token, verifies that one
connected launcher advertises both `ai` and `cae`, then runs
`cae.solvers.manifests`, `ai.llm.models`, and a streaming `ai.chat` session
that is explicitly finished.

The normal test suite reports this test as skipped when either required
credential is absent:

```powershell
npm test
```

To opt in:

```powershell
$env:CAEMBLE_V1_E2E_API_BASE_URL = "https://www.caemble.com/api"
$env:CAEMBLE_V1_E2E_CLIENT_TOKEN = "<client-scoped-token>"
$env:CAEMBLE_V1_E2E_TIMEOUT_SECONDS = "300" # optional
npm run test:live
```

The JavaScript SDK uses browser WebRTC directly. Stock Node.js does not expose
`RTCPeerConnection`, so the live test reports a second explicit skip unless
the selected Node-compatible runtime or an existing preload supplies
`RTCPeerConnection` together with `fetch`, `Headers`, and `Blob`. The SDK does
not add a WebRTC polyfill dependency for this smoke test.

The Caemble UI also owns a Chromium version of the same opt-in contract smoke.
With the environment variables above still set, run it in a real browser:

```powershell
cd ../../../ui
npm run test:e2e -- --grep "frozen JavaScript v1 SDK contract"
```

Without the URL or token, this browser smoke is also reported as skipped.
