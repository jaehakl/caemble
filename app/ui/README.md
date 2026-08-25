# Caemble UI

React 19, React Router Data Mode, Tailwind CSS v4, and Vite power the Caemble
Workbench. The product routes are `/` for the Workbench and `/docs` for the
manual/catalog reference. Workspaces and managers open from the Workbench;
unsupported historical routes return Not Found.

An unauthenticated visitor receives an editable local Starter and can compile
and preview it without the API. Sign-in gates persistence, remote execution,
and provider-backed features.

## Local development

Build the repository-local browser SDK once, then install and run the UI:

```powershell
Push-Location ../sdk/master/js
npm ci
npm run build
Pop-Location

npm ci
npm run dev
```

The host app runs at `http://localhost:5173` and the isolated Code-to-CAD runner
at `http://localhost:5174`. `/api` proxies to `http://localhost:8000` with the
prefix removed. To use custom ports, set both `VITE_CAEMBLE_HOST_ORIGIN` and
`VITE_CAEMBLE_RUNNER_ORIGIN`.

Routine validation is intentionally small; run contract and browser checks when
the affected boundary requires them:

```powershell
npm test
npm run check:docs
npm run test:contracts
npm run test:full
npm run lint
npm run build
npm run test:e2e
```

`npm test` is the fast iteration suite. `test:contracts` contains the slower
compiler/worker/integration contracts, and `test:full` runs both. Production
builds regenerate and verify the pinned CAD API; a non-empty generated diff is
an error.

## Ownership

- `src/app`: providers and the `/` + `/docs` router.
- `src/pages/cae`: Workbench chrome, session, and dialog orchestration.
- `src/pages/docs`: the canonical user manual shell.
- `src/features`: authentication, Viewer/editor persistence, AI, and the thin
  CAE client.
- `src/api`: fetch clients and Zod response validation.
- `src/lib/cad`: source model, generated CAD API declarations, compiler, isolated runner,
  evaluation, and serialization.
- `src/lib/material`, `src/lib/quantitykind`, `src/lib/solver`: domain models
  that consume API/catalog contracts.

The [architecture guide](../../docs/architecture.md) describes Experiment
bundle versions and cross-component flow. Keep user-facing authoring examples
in `/docs` and the executable example/element registries, not in this README.

## Catalog and generated sources

The shared SQLite catalog is the only source for QuantityKind, Material, and
Solver data. The UI has no full catalog or Solver-manifest copy. `/docs` queries
the catalog API, while an Experiment requests only the pinned runtime slice it
references.

Element definitions and `src/lib/cad/api/authoring-manifest.json` generate the
element catalog, JSX intrinsics, and `@caemble/core` declaration. Change those
sources and run:

```powershell
npm run generate:cad-api
npm run check:generated
```

Commit all intended generated changes. Do not hand-copy element props or
catalog entries into TypeScript or Markdown.

## Browser/runtime boundary

The runner is served from a separate origin with `connect-src 'none'`. A
nonce-bound `MessageChannel` sends schema-validated requests to a disposable
Worker; the host never evaluates author source. The runner needs
`'unsafe-eval'` for TypeScript CommonJS output, but that exception must not be
added to the host CSP.

Browser jobs use cookie-authenticated `/web/jobs`. Browser storage never holds
an Access Token; Account-created `client` and `launcher` tokens are for external
SDKs and launchers only.

Simulation callers go through `src/features/cae/client.ts`, which sends
`{ formatVersion: 2, measurement, solverContracts }` and owns attachments, progress, record ACK,
cancellation, and cleanup. There is no browser-local Solver fallback.

## Production runner

Set distinct origins at build time:

```dotenv
VITE_API_BASE_URL=/api
VITE_CAEMBLE_HOST_ORIGIN=https://app.example.com
VITE_CAEMBLE_RUNNER_ORIGIN=https://cad-runner.example.com
```

Serve `runner.html` and every asset it references from the runner origin. Do not
place cookies, credentials, user data, analytics, service-worker scope, or
general application endpoints there. The complete production procedure and
headers are in [deployment](../../deployment/deployment.md).
