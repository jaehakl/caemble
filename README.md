# Caemble

Caemble is a local-first CAE Workbench for authoring CAD-backed Experiments,
preparing Measurements, and running them through remote CAE workers. This
repository contains the browser UI, FastAPI service, shared catalog, launcher,
worker applications, and v1-compatible client SDKs.

```text
app/
  ui/        React Workbench and isolated Code-to-CAD runner
  api/       FastAPI, authentication, persistence, and job orchestration
  catalog/   shared QuantityKind, Material, and Solver SQLite catalog
  launcher/  per-user worker launcher
  slaves/    AI and CAE worker applications
  sdk/       worker protocol and JavaScript/Python master SDKs
```

QuantityKind, Material, and Solver catalog data belongs only in
`app/catalog/caemble_catalog/catalog.sqlite3`. The files
`app/slaves/*/manifest.json` describe launcher executables; they are not Solver
contracts.

## Quick start

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
Push-Location app/sdk/master/js
npm ci
npm run build
Pop-Location

Push-Location app/ui
npm ci
npm run dev
Pop-Location
```

The Workbench opens at `http://localhost:5173/`; its user manual and live
catalog reference are at `http://localhost:5173/docs`. An unauthenticated user
can edit and preview a local Starter. Sign-in is required for persistence,
provider-backed AI, and remote execution.

To run workers, create a `launcher` token in Account, install only the worker
projects needed by that machine, configure the launcher's `.env`, and start
`app/launcher`. See the component READMEs for local details.

## Documentation

- The in-app `/docs` route is the canonical user manual for Workbench authoring,
  current examples, and live catalog reference.
- [Architecture](docs/architecture.md) explains source formats, runtime
  boundaries, and where to read the implementation.
- [Solver development](docs/solver-development.md) is required reading before
  adding or changing a CAE Solver.
- [v1 SDK compatibility](docs/v1-sdk-compatibility.md) defines the frozen public
  SDK boundary.
- [Deployment](deployment/deployment.md) covers the current Ubuntu production
  setup.
- [Historical plan](docs/archive/2026-08-plan.md) records earlier product notes;
  it is not a current specification.

Per-component setup and ownership notes live next to each project:
[UI](app/ui/README.md), [API](app/api/README.md),
[workers](app/slaves/README.md), [CAE worker](app/slaves/cae/README.md), and
[SDKs](app/sdk/README.md).

## Validation

Run the focused test for the area being edited first. The routine suites omit
explicit slow/live contracts:

```powershell
Push-Location app/ui
npm test
npm run check:docs
Pop-Location

Push-Location app/api
poetry run pytest -q -m "not slow and not live"
Pop-Location
```

Before merging a cross-boundary change, run the fuller checks:

```powershell
Push-Location app/ui
npm run test:contracts
npm run test:full
npm run lint
npm run build
Pop-Location

Push-Location app/api
poetry run pytest -q
Pop-Location
```

Run the relevant `pytest`/`npm test` command inside `app/catalog`,
`app/launcher`, `app/sdk`, `app/slaves/ai`, or `app/slaves/cae` when those
projects change. Live provider checks remain opt-in and may incur cost.

## Runtime boundaries

- First-party browser requests use cookies and CSRF-protected `/web` routes;
  third-party SDKs use bearer tokens and `/v1`.
- Job payloads and attachments travel over WebRTC between client and worker.
  The API stores orchestration state rather than solver payloads.
- One launcher executes one job at a time. Run additional launchers for
  concurrency.
- Launcher WebSocket and active Agent state are process-local, so the API must
  run as one worker/replica.
- Google STUN is the default ICE service; no managed TURN service is included.
