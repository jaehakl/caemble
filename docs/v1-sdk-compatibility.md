# v1 SDK compatibility

Caemble owns the v1 orchestration server and SDK source under this repository. The
public v1 wire contract remains compatible with the GPStation 0.1.0 master SDKs so
an existing client only has to change its API base URL:

```text
https://<caemble-host>/api
```

The existing bearer token must first be imported into the Caemble database. New
clients can instead create a `client` token from the Caemble Account page. Tokens
with `launcher` scope are for the launcher control WebSocket and must not be
embedded in third-party applications.

## Frozen public contract

- JavaScript package: `@gpstation/v1-master-js-sdk`
- Python package: `gpstation-v1-master-python-sdk`
- REST routes: `/v1/launchers` and `/v1/jobs*`
- Launcher WebSocket: `/v1/launchers/control`
- WebRTC DataChannel label: `gpstation.v1`
- Job states and SDP/ICE JSON field names from v1
- CAE handlers: `cae.solvers.manifests`, `cae.simulation.start`,
  `cae.simulation.next`
- AI handlers:
  - `ai.llm`, `ai.chat`, `ai.llm.models`
  - `ai.embeddings`, `ai.embeddings.batch`, `ai.embeddings.models`
  - `ai.clip.image`, `ai.clip.text`, `ai.wd14.tags`
  - `ai.sdxl.t2i`, `ai.sdxl.i2i`, `ai.sdxl.inpaint`,
    `ai.sdxl.controlnet.t2i`, `ai.sdxl.controlnet.i2i`,
    `ai.sdxl.controlnet.inpaint`, `ai.sdxl.models`
  - `ai.voicevox.speakers`, `ai.voicevox.audio_query`,
    `ai.voicevox.synthesis`

New Caemble functionality must be additive or use a new API version. Renaming
fields, changing response types, adding fields to strict launcher control frames,
or changing the DataChannel framing would break existing clients.

## Authentication and ownership

The public `/v1` API accepts bearer access tokens only. A `client` token can list
and create jobs for launchers owned by the same Caemble user. The
`/v1/launchers/control` WebSocket requires a `launcher` token. First-party
Caemble pages use the authenticated cookie routes under `/web` and do not expose a
bearer secret to the browser UI.

Browser clients may call `/v1` through credential-free CORS with an
`Authorization: Bearer ...` header. Cookie-authenticated `/web` routes only allow
configured Caemble origins and require `X-CSRF-Token` on unsafe requests.

## Runtime boundary

The API stores orchestration state, progress, and errors. Solver requests,
attachments, streamed AI output, and CAE recorded data travel directly between
the master client and slave worker over WebRTC. A launcher runs one job at a time;
use multiple launchers when concurrent jobs are required.

Caemble supplies STUN configuration but no managed TURN service. Connections
across restrictive NAT or firewall policies can therefore fail even when both the
API and launcher are healthy.
