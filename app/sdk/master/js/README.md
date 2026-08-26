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

The same `attachments` option is available on `session.call`.
