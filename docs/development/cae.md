# Caemble CAE worker

Commands and component-relative paths in this document are relative to `app/slaves/cae`, unless stated otherwise.

The CAE worker receives a trusted built Measurement from the GPStation server
over its job WebSocket, executes its Solvers, and uploads RecordedData directly
to the server. The launcher controls its process; browsers observe server events.
CAE uses only server-master jobs. AI and other WebRTC slaves retain their existing
master connections.

Read [Solver development](solver-development.md) and this
project's `AGENTS.md` completely before adding or changing a Solver.

## Local setup

```powershell
poetry install
```

Poetry is configured to use `app/slaves/cae/.venv`. If another environment is
selected, remove that Poetry environment and reinstall from this directory.

## Ownership

- `app/kernel/api`: Solver ABI, StatePatch, detached domain/field values,
  and unit contracts.
- `app/kernel/coordinator`: immutable RunPlan/TaskSpec snapshots,
  SimulationApi, Python AST policy, and result commit/rollback.
- `app/kernel/execution`: spawn child processes, IPC, cancellation,
  temporary workspaces, and mmap transactions.
- `app/kernel/resources`: state lineage, live roots, artifact leases,
  shared buffers, and run caches.
- `app/kernel/transport`: GPStation handlers, schema-based recording
  conversion, and ACK-owned RecordPackets.
- `app/kernel/catalog`: descriptor snapshots and implementation locators.
- `app/methods`: numerical and geometry building blocks selected by Solvers.
- `app/solvers/<package>/entry.py`: current Solver implementation and readable orchestration.
- `app/__init__.py` and `app/__main__.py`: package marker and thin executable entry point.

All runtime business logic lives in `kernel`; numerical methods and physics
remain in their own layers. There are no legacy import facades, ABI adapters,
or versioned implementation directories. Do not add registration conditionals
or Solver manifests.

## Contracts

QuantityKind, Material Model definitions, and Solver descriptors come only from
`app/catalog/caemble_catalog/catalog.sqlite3`. The worker loads active Solver
descriptors and model definitions at startup, then closes the database. Solver
modules are imported only inside the spawned invocation child. ABI 3 receives
Material model instances, normalized parameters and model-group selections from
the saved BuiltMeasurement. RunPlan validates captured definitions and parameter
structure before invoking a Solver, which checks its numerical constraints.
Material names identify only inputs within that Experiment; the worker never
uses them to fetch coefficients. New Candidate Vars cause material.tsx to be
reevaluated, while a recorded Measurement retains its original input snapshot.
Catalog has one current version per Solver name and rewritten official examples.
Removed Solver versions fail lookup; old user Experiments are not migrated or
redirected. Historical code and Catalog releases remain in Git.

Each Solver sees two local scopes: `experiment` for the common scene and `task`
for its task-local scene. Unit conversion modifies only that Solver view, never
the stored Geometry or frozen Material snapshot. `simulate.py` may call only
`sim.run`, `sim.record`, and `sim.release` under the AST policy.

That policy is a guardrail for trusted Experiment code, not an OS sandbox. Run
the worker under a dedicated account or container in production. API, UI, and
resident CAE workers must use the same catalog release, and workers must restart
after a catalog deployment.

## Resource and recording boundaries

Solver values use `FieldValue` with a self-contained domain; only the resident
resource graph uses `ResourceRef`. Domain fields use `FieldValue`; compound
outputs and retained ray paths use `BundleValue`. ABI 1, ABI 2 and legacy resource
mappings are not supported.
State lineage survives explicit root release, while live state, artifacts,
invocations, and ACK packets independently retain the resources they need.
`sim.release(state, keep=next_state)` preserves an unchanged revision;
`keep=(next_state, checkpoint)` also preserves a checkpoint. Empty revision 0 is
never released, and an active invocation's base state cannot be released.

Recording projects artifacts onto the declared RecordedData schema before
tensor encoding. Existing tensor schemas keep their wire format. An explicit
group can additionally preserve domain coordinates, connectivity, identity and
field metadata using the projection names in the Solver development guide.
The `/docs` route documents authoring syntax and examples.

Each record retains its resources until the server confirms durable staging.
Completion is sent only after every record ACK and after invocation children,
deferred process cleanup, and run resources have closed. The launcher releases
its job slot after the server completion ACK and the worker's `job.cleaned` message.
Cancellation and connection loss also await cleanup. Interrupted computations fail;
retry is an explicit server action, and the worker never restarts computation itself.

## Tests

Run from this directory after installing the project and pytest dependencies:

```powershell
poetry run python -m pytest tests -m "not cuda"
poetry run python -m pytest tests/test_fdtd_cuda.py -m cuda
```

The first command includes import-boundary, unit, lifecycle, and CPU integration
tests, including all official Catalog bundles compiled through the UI and run
as nominal Measurements with real child execution and record ACKs. These tests
require the UI npm dependencies. The second opts into an actual CUDA execution and skips when CUDA is
unavailable; report that skip separately from a GPU pass. Retain existing
numerical tolerances. Compare revision metadata, retained resource nodes and
mmap files separately when checking repeated calls.

## Runtime measurements

Use the same benchmark script and Python environment for both package snapshots:

```powershell
poetry run python benchmarks/runtime.py --package-root <baseline-cae-directory>
poetry run python benchmarks/runtime.py
poetry run python benchmarks/runtime.py --release-previous
```

The JSON output reports repeated batch medians for a mocked `sim.run()`
(validation and commit included, numerical Solver and child startup excluded),
4 MiB array materialization/mmap transfer, and retained resources after 24 state
replacements. The release flag deliberately changes the lifetime policy to retain
only the current state and first checkpoint; old handle objects are kept in all
cases. Run sequentially while other tests are idle. Compare the no-release runs
for refactoring overhead and the release run for the explicit lifetime policy.
