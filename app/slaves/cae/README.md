# Caemble CAE worker

The CAE worker accepts a trusted built Measurement, executes its Solvers,
and streams the RecordedData produced by the Experiment.

Read [Solver development](../../../docs/solver-development.md) and this
project's `AGENTS.md` completely before adding or changing a Solver.

## Local setup

```powershell
poetry install
```

Poetry is configured to use `app/slaves/cae/.venv`. If another environment is
selected, remove that Poetry environment and reinstall from this directory.

## Ownership

- `app/runtime_kernel/api`: Solver ABI, StatePatch, detached domain/field values,
  and unit contracts.
- `app/runtime_kernel/coordinator`: immutable RunPlan/TaskSpec snapshots,
  SimulationApi, Python AST policy, and result commit/rollback.
- `app/runtime_kernel/execution`: spawn child processes, IPC, cancellation,
  temporary workspaces, and mmap transactions.
- `app/runtime_kernel/resources`: state lineage, live roots, artifact leases,
  shared buffers, and run caches.
- `app/runtime_kernel/transport`: GPStation handlers, schema-based recording
  conversion, and ACK-owned RecordPackets.
- `app/runtime_kernel/catalog`: descriptor snapshots and implementation locators.
- `app/methods`: numerical and geometry building blocks selected by Solvers.
- `app/solvers/<package>/v<version>/entry.py`: versioned Solver implementations.

The former top-level modules and `solver_framework` imports are compatibility
facades. New code uses the three layers above. Do not add registration
conditionals or Solver manifests.

## Contracts

QuantityKind, Material, and Solver data comes only from
`app/catalog/caemble_catalog/catalog.sqlite3`. The worker loads active Solver
descriptors at startup, then closes the database. Solver modules are imported
only inside the spawned invocation child. CAD, Geometry, Simulation, Material, Catalog, and built
Measurement payloads are trusted and unversioned. The worker reads them
directly; malformed values fail through their natural runtime operation.

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
resource graph uses `ResourceRef`. Existing mapping outputs retain their shapes.
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

## Tests

Run from this directory after installing the project and pytest dependencies:

```powershell
poetry run python -m pytest tests -m "not cuda"
poetry run python -m pytest tests/test_fdtd_cuda.py -m cuda
```

The first command includes import-boundary, unit, lifecycle, and CPU integration
tests. The second opts into an actual CUDA execution and skips when CUDA is
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
