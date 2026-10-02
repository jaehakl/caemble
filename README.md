# Caemble

Caemble develops CAD-backed Experiments and Calculations through a server web
Workbench or the monorepo Node CLI. A shared builder creates frozen Measurement
artifacts. The CLI tests them locally; the API dispatches committed batches to
remote CAE workers.

```text
app/
  ui/        React Workbench and monorepo Node CLI commands
  api/       FastAPI, authentication, persistence, and job orchestration
  launcher/  per-user worker launcher
  slaves/
    ai/
    tts/
    cae_simulation/
    cae_evaluation/
    cae_prediction/
shared/
  catalog/              QuantityKind, Material, and Solver SQLite catalog
  sdk/                  worker protocol and JavaScript/Python master SDKs
  prediction_contracts/  Forward algorithm versions, capabilities, and resource requirements
  execution/            shared CAD, Measurement, Calculation, and Node execution
```

QuantityKind, Material, and Solver catalog data belongs only in
`shared/catalog/caemble_catalog/catalog.sqlite3`. The files
`app/slaves/*/manifest.json` describe launcher executables; they are not Solver
contracts.

## Quick start

For local authoring, install Node 24.14 or later and Poetry, then run from the
repository root:

```powershell
npm ci
npm --prefix app/ui run build:cli
Push-Location app/slaves/cae_simulation
poetry install --with dev
Pop-Location
.\caemble.cmd doctor
.\caemble.cmd agent guide experiment
```

Use `sh ./caemble` on POSIX. API operations additionally use the root `.env`
configuration described in `.env.example`, with a web-issued `caemble` key.
The CLI has no interactive local web server.

### Web application development

Start PostgreSQL, copy `app/api/.env.example` to `app/api/.env`, and configure
the database and OAuth values. Then run the API:

```powershell
Push-Location app/api
poetry install
poetry run alembic upgrade head
poetry run uvicorn main:app --app-dir app --host 127.0.0.1 --port 8000
Pop-Location
```

Build the repository-local browser SDK and start the UI:

```powershell
npm ci
npm --prefix app/ui run build:sdk
npm --prefix app/ui run dev
```

The Workbench opens at `http://localhost:5173/`; its user manual and live
catalog reference are at `http://localhost:5173/?help=home`. An unauthenticated user
can edit and preview a local Starter. Sign-in is required for persistence,
provider-backed AI, and remote execution.

To install or update the Launcher and all five worker environments on Linux/WSL,
run `bash ./li_launcher_install.sh` from the repository root. It installs the
current lockfiles and prepares Evaluation from the shipped release archive.
Create a `launcher` token in Account, configure `app/launcher/.env`, and start
the Launcher separately. AI/TTS model preparation remains explicit. See
[worker installation](docs/operations/workers.md) for prerequisites and local setup.

## Documentation

Start at the [documentation map](docs/README.md). [AGENTS.md](AGENTS.md) is the
short agent entry point. The web manual and CLI share Markdown sources for
[Experiment](docs/authoring/experiment.md), [Calculation](docs/authoring/calculation.md),
and [Solver](docs/authoring/solver.md) authoring.

- Workbench Help is the canonical user manual for Workbench authoring,
  current examples, and live catalog reference.
- [Architecture](docs/development/architecture.md) explains trusted payloads, runtime
  boundaries, and where to read the implementation.
- [Solver development](docs/development/solver-development.md) is required reading before
  adding or changing a CAE Solver.
- [Deployment](docs/operations/deployment.md) covers the current Ubuntu production
  setup.

Detailed setup and ownership notes are maintained centrally:
[UI](docs/development/ui.md), [API](docs/development/api.md),
[workers](docs/operations/workers.md), [CAE worker](docs/development/cae.md), and
[SDKs](shared/sdk/README.md).

## Runtime boundaries

- First-party browser requests use cookies and CSRF-protected routes; the CLI
  uses `caemble` keys, while SDK clients retain their `client` token routes.
- The browser and CLI build inputs before submission. The API persists artifact
  inputs, commits jobs atomically, and stores recorded results. CAE workers use
  job-scoped WebSockets with binary attachments; the browser observes batch SSE.
- General AI workers retain their existing WebRTC master connections.
- One launcher executes one job at a time. Run additional launchers for
  concurrency.
- Launcher WebSocket and dispatcher state are process-local, so the API must
  run as one worker/replica.
- Google STUN is the default ICE service; no managed TURN service is included.
