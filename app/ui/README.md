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

Build the browser SDK and production application with:

```powershell
npm run build
```

## Ownership

- `src/app`: providers and router bootstrap.
- `src/routes`: only the `/`, `/docs`, and Not Found route entries.
- `src/workbench`: Workbench session orchestration, scoped shell store, and
  feature-to-shell adapters.
- `src/features`: user-facing workflows such as Experiment, Measurement,
  Calculation, Prediction, Analysis, Viewer, Materials, AI, and Runtime.
- `src/contracts`: serialized contracts grouped by owning domain. `src/api/types.ts`
  remains a compatibility re-export, not the source of new contracts.
- `src/api`: HTTP transport and the existing `dbTables` endpoint facade.
- `src/platform/isolated-runner`: the generic cross-origin iframe runner client,
  frame, and protocol.
- `src/lib/cad`, `src/lib/material`, and `src/lib/quantitykind`: framework-free
  domain models, compilation, evaluation, and serialization.
- `src/shared`: application-independent UI and layout primitives.

Dependencies flow from app/routes into workbench/features, then into
domain/platform and contracts/shared. `npm run check:dependencies` rejects
cycles and reverse imports.

Keep `dbTables` keys, method names, endpoints, and `recordType` compatibility
stable. New serialized types belong to their owning `src/contracts` module;
validate unknown HTTP, storage, WebSocket, and Worker payloads at the boundary.

## Validation

Run the complete maintainability check with:

```powershell
npm run check
```

`npm run build` additionally type-checks the application, builds the local SDK,
and verifies the Calculation bundle.

The [architecture guide](../../docs/architecture.md) describes Experiment
bundle flow. Keep user-facing authoring examples
in `/docs` and the executable example/element registries, not in this README.

## Catalog and generated sources

The shared SQLite catalog is the only source for QuantityKind, Material, and
Solver data. The UI has no full catalog or Solver-manifest copy. `/docs` queries
the catalog API, while an Experiment requests only the pinned runtime slice it
references.

Element definitions generate the element catalog, JSX intrinsics, and
`@caemble/core` declaration. Change those sources and run:

```powershell
npm run generate:cad-api
```

Commit all intended generated changes. Do not hand-copy element props or
catalog entries into TypeScript or Markdown.

## Browser/runtime boundary

The runner is served from a separate origin with `connect-src 'none'`. A
nonce-bound `MessageChannel` sends operation-scoped requests to a disposable
Worker; the host never evaluates author source. The runner needs
`'unsafe-eval'` for TypeScript CommonJS output, but that exception must not be
added to the host CSP.

Browser jobs use cookie-authenticated `/web/jobs`. Browser storage never holds
an Access Token; Account-created `client` and `launcher` tokens are for external
SDKs and launchers only.

Simulation callers go through `src/features/cae/client.ts`, which sends the
BuiltMeasurement and owns attachments, progress, record ACK,
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
