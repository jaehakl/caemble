# Caemble CAE worker

The CAE worker accepts a trusted built Measurement, executes its Python kernels,
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

- `app/handlers.py`: `cae.simulation.start`/`next`, attachments, and streamed
  responses.
- `app/runtime.py`: run lifecycle, orchestration, record ACKs, cancellation, and
  artifact ownership.
- `app/program.py`: Python simulation API and its AST allowlist.
- `app/solver_framework/registry.py`: catalog snapshot, implementation locators,
  and lazy imports.
- `app/solver_framework/units.py` and `world.py`: unit and Solver-view
  transformations.
- `app/solver_framework/numerics`: shared numerical building blocks.
- `app/solvers/*/solver.py`: Solver-specific calculations.

`app/kernels.py` is only a compatibility facade. Do not add registration
conditionals or Solver manifests there.

## Contracts

QuantityKind, Material, and Solver data comes only from
`app/catalog/caemble_catalog/catalog.sqlite3`. The worker loads active Solver
descriptors at startup, then closes the database. Solver modules are imported
only on first use. CAD, Geometry, Simulation, Material, Catalog, and built
Measurement payloads are trusted and unversioned. The worker reads them
directly; malformed values fail through their natural runtime operation.

Each kernel sees two local scopes: `experiment` for the common scene and `task`
for its task-local scene. Unit conversion modifies only that Solver view, never
the stored Geometry or frozen Material snapshot. `simulate.py` may call only
`sim.run`, `sim.record`, and `sim.release` under the AST policy.

That policy is a guardrail for trusted Experiment code, not an OS sandbox. Run
the worker under a dedicated account or container in production. API, UI, and
resident CAE workers must use the same catalog release, and workers must restart
after a catalog deployment.
