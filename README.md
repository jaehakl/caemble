# Caemble

Caemble is a standalone CAD, experiment, and remote execution application. The
repository contains its FastAPI service, Vite UI, v1-compatible client SDKs,
launcher, and the built-in AI and CAE slave codebases.

```text
app/
  api/       FastAPI, OAuth, access tokens, launchers, and jobs
  catalog/   shared read-only QuantityKind, Material, and Solver SQLite catalog
  ui/        Caemble browser application
  sdk/       shared protocol plus JavaScript and Python master SDKs
  launcher/  per-user slave process launcher
  slaves/
    ai/      AI worker and local model catalog
    cae/     CAE worker and solver implementations
```

`app/slaves/*/manifest.json` remains the executable launcher registry. QuantityKind,
Material, and CAE Solver contracts live in the versioned SQLite file provided by
`app/catalog`; the API and CAE worker consume that shared package. See
[Solver development](docs/solver-development.md) before adding or changing a Solver.

## Local setup

Install and migrate the API:

```powershell
cd app/api
poetry install
poetry run alembic upgrade head
poetry run uvicorn main:app --app-dir app --host 127.0.0.1 --port 8000
```

Build the local JavaScript SDK and start the UI:

```powershell
cd app/sdk/master/js
npm ci
npm run build

cd ../../../ui
npm ci
npm run dev
```

Sign in to Caemble and create a `launcher` Access Token from Account. Install each
slave that this machine should advertise, then start the launcher:

```powershell
cd app/slaves/cae
poetry install

cd ../ai
Copy-Item models.example.toml models.toml
# Edit models.toml with launcher-local LLM, SDXL, and embedding models.
poetry install

cd ../../launcher
Copy-Item .env.example .env
# Set CAEMBLE_API_URL and CAEMBLE_ACCESS_TOKEN.
poetry install
poetry run launcher
```

The launcher executes one job at a time and switches its persistent worker
between `ai` and `cae`. Run more launchers for concurrent jobs. AI model files,
`models.toml`, VOICEVOX runtime files, virtual environments, and caches are local
machine state and must not be committed.

## Client compatibility

Existing GPStation v1 JavaScript and Python clients can target a deployed Caemble
server by changing only their base URL to `https://<caemble-host>/api`, provided
the existing client token has been imported. New integrations can create a
Caemble `client` token instead.

See [v1 SDK compatibility](docs/v1-sdk-compatibility.md) for the frozen public
contract and [deployment](deployment/deployment.md) for the production setup.


## Runtime boundaries

- First-party UI requests use Caemble cookies and CSRF-protected `/web` routes.
- Third-party SDK requests use bearer tokens and `/v1`.
- Job payloads and attachments move over WebRTC between client and slave; the API
  stores orchestration state rather than solver data.
- CAE receives `{ measurement: BuiltMeasurement, solverContracts }`, verifies the selected
  Solver contract digests against its local catalog, and then returns progress, cancellation,
  and recorded data.
- The default ICE configuration uses Google STUN. No managed TURN service is
  included.
- The API must run as one process because launcher WebSocket state is in memory.
