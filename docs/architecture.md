# Caemble architecture

This document is for contributors who need the current source and runtime
boundaries. The in-app `/docs` route is the canonical user manual for authoring
syntax, examples, troubleshooting, and live catalog reference; do not duplicate
those details in Markdown.

## Current formats

| Contract | Version | Owner |
| --- | ---: | --- |
| Experiment source bundle | 5 | UI source document model |
| CAD document | 2 | UI Code-to-CAD runner |
| CAD authoring API | 7 | generated UI declaration and element registry |
| Published Geometry module | 4 | API publish/resolve boundary |
| Simulation manifest | 5 | UI evaluation and CAE runtime |
| Python simulation API | 3 | CAE program runtime |
| Material snapshot | 2 | UI Measurement builder |

An Experiment revision atomically owns this source bundle:

```text
experiment.tsx
geometry.tsx
material.tsx
simulate.py
tasks/<taskName>.tsx   (one or more)
geometrySnapshot      (published Geometry dependency graph)
```

`experiment.tsx` owns common units, variables, physical geometry, groups, and
RecordedData declarations. `geometry.tsx` exports shared Geometry components;
`material.tsx` exports Material values or factories. Each Task selects a pinned
Solver name/version and owns its config plus optional task-local geometry.
`simulate.py` orchestrates Tasks through `sim.run`, `sim.record`, and
`sim.release`.

CAD API v7 uses `position`, `rotation`, and `scale` as canonical transforms.
Material assignment uses named roles such as `body`, `tire`, or `shell`, not
positional arrays. Published Geometry imports use exact coordinates of the form
`caemble:geometry/<namespace>/<repository>/<package>@X.Y.Z`.

Authoring examples and element-specific props belong in generated executable
examples and the live Geometry Catalog exposed by `/docs`. When syntax changes,
update the registry/authoring manifest and regenerate declarations instead of
copying a new prose example here.

## Data flow

```text
Experiment revision + complete vars
  -> isolated UI compile/evaluate
  -> deterministic common and Task-local scenes
  -> frozen Material snapshot
  -> prepared Measurement
  -> { measurement: BuiltMeasurement, solverContracts }
  -> CAE worker contract validation and execution
  -> sim.record() DataTensor values
  -> atomic RecordedData attachment
  -> Viewer and Analysis
```

Source and candidate values are separate. Creating a candidate samples values
inside `varsSchema` and freezes its Materials; it does not rewrite source,
persist a Measurement, or run a Solver. Persisted Measurement vars are complete
and strict. A failed or cancelled run leaves the prepared Measurement unchanged.
A successful run attaches all declared RecordedData once; repeating the same
conditions requires a new Measurement.

The API stores immutable authoring revisions, ownership, Measurement conditions,
RecordedData, and orchestration state. It does not execute CAD or physics.
Payloads and attachments travel over WebRTC between the client and worker.

## Ownership boundaries

| Area | Responsibility |
| --- | --- |
| UI | authoring, isolated evaluation, preview, candidate generation, Material freezing, BuiltMeasurement serialization |
| API | OAuth/tokens, immutable revisions, ownership, prepared Measurements, one-time RecordedData transaction, job orchestration |
| Catalog | the sole QuantityKind, Material, and Solver data source in `catalog.sqlite3` |
| Launcher | discovers executable manifests, owns one active worker/job, and bridges the control WebSocket |
| CAE worker | verifies catalog digests, converts units, validates target/method contracts, runs `simulate.py` and Solvers |
| AI worker | executes the public v1 AI handlers using machine-local model/provider configuration |
| SDKs | preserve the public v1 REST, WebSocket, WebRTC, frame, and attachment contracts |

`app/slaves/ai/manifest.json` and `app/slaves/cae/manifest.json` are executable
launcher manifests. Solver contracts are relations in
`app/catalog/caemble_catalog/catalog.sqlite3`; there is no parallel JSON or
TypeScript Solver catalog.

## Catalog and Solver boundary

The UI reads searchable catalog data from the API and requests only the runtime
slice referenced by the current Experiment. A CAE request contains the unique
Solver identities and `contractDigest` values used by its Tasks. The CAE worker
compares these against its local SQLite snapshot before it creates a run.

Every Solver target has the form `<scope>.<kind>.<group>`:

- `experiment.geometry.*` and `experiment.surface.*` address the common scene.
- `task.geometry.*` and `task.surface.*` address the current Task-local scene.

The selected method's catalog relation determines which source/kind is valid.
Units are converted only in the Solver's local view; the stored Geometry and
Material snapshot remain unchanged. See [Solver development](solver-development.md)
before modifying this boundary.

## Code-reading path

For Experiment authoring and evaluation, read in this order:

1. [`document.ts`](../app/ui/src/lib/cad/source/document.ts) — accepted files and
   pinned format/API versions.
2. [`sourceAnalysis.ts`](../app/ui/src/lib/cad/source/sourceAnalysis.ts) — import
   and determinism policy.
3. [`evaluateDocument.ts`](../app/ui/src/lib/cad/execution/evaluateDocument.ts) —
   isolated runner boundary.
4. [`userModule.ts`](../app/ui/src/lib/cad/execution/userModule.ts) — common and
   Task-local scene evaluation and Simulation manifest creation.
5. [`measurement.ts`](../app/ui/src/lib/cad/execution/measurement.ts) — frozen
   Material snapshot and BuiltMeasurement construction.
6. [`request.ts`](../app/ui/src/features/cae/request.ts) — wire payload and tensor
   attachment sharding.

For remote execution and persistence, continue with:

1. [`client.ts`](../app/ui/src/features/cae/client.ts) — simulation lifecycle,
   progress, record acknowledgements, and cancellation.
2. [`handlers.py`](../app/slaves/cae/app/handlers.py) — CAE wire handlers.
3. [`runtime.py`](../app/slaves/cae/app/runtime.py) — run and artifact ownership.
4. [`program.py`](../app/slaves/cae/app/program.py) — Python API v3 and AST policy.
5. [`registry.py`](../app/slaves/cae/app/solver_framework/registry.py) — SQLite
   contract snapshot, digest verification, and lazy Solver import.
6. [`measurement_service.py`](../app/api/app/service/measurement_service.py) —
   ownership, source-hash check, and atomic RecordedData persistence.

The `simulate.py` AST allowlist is a guardrail for trusted Experiment source,
not an operating-system sandbox. Production workers still require an OS account
or container boundary.

## Validation boundary

Local unit and contract suites prove serialization, validation, and lifecycle
behavior in their test environments. They do not prove browser layout, live
provider credentials, network traversal, a deployed database migration, or a
real launcher-to-worker connection. Report those checks separately.

Use the root [validation commands](../README.md#validation), then add the
component-specific checks for every boundary changed. Cross-component catalog
changes require the same catalog release in the API/UI deployment and a restart
of resident CAE workers.
