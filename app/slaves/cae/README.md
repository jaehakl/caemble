# Caemble CAE worker

The CAE worker accepts a fully built Measurement, verifies every referenced
Solver contract against its local shared catalog, executes Python kernels, and
returns only the RecordedData declared by the Experiment.

Read [Solver development](../../../docs/solver-development.md) and this
project's `AGENTS.md` completely before adding or changing a Solver.

## Local setup

```powershell
poetry install
poetry run python -c "import app, numpy, aiortc"
poetry run pytest -q
```

Poetry is configured to use `app/slaves/cae/.venv`. If another environment is
selected, remove that Poetry environment and reinstall from this directory.

The real UI-to-CAE fixture suite is intentionally a slower contract. Regenerate
a fixture with the UI serializer and run its focused test when the bundle,
measurement, catalog, or wire boundary changes:

```powershell
Push-Location ../../ui
npm run export:cae-fixture -- --example caemble:experiment/caemble/verified/dc-uniform-bar@1.0.0 --out ../slaves/cae/tests/fixtures/dc-uniform-bar
Pop-Location

poetry run pytest -q tests/test_fixture_e2e.py -k dc_uniform_bar
```

This exercises the handlers, tensor attachments, Solver, record ACKs, and
terminal sequence. It does not prove a browser/launcher/WebRTC deployment.

## Ownership

- `app/handlers.py`: `cae.simulation.start`/`next`, attachments, and public v1
  compatibility responses.
- `app/runtime.py`: run lifecycle, orchestration, record ACKs, cancellation, and
  artifact ownership.
- `app/program.py`: Python simulation API v3 and its AST allowlist.
- `app/solver_framework/registry.py`: catalog snapshot, contract digest checks,
  implementation locators, and lazy imports.
- `app/solver_framework/validation.py`, `units.py`, and `world.py`: method,
  target, tensor, and UCUM conversion boundaries.
- `app/solver_framework/numerics`: shared numerical building blocks.
- `app/solvers/*/solver.py`: Solver-specific calculations.

`app/kernels.py` is only a compatibility facade. Do not add registration
conditionals or Solver manifests there.

## Contracts

QuantityKind, Material, and Solver data comes only from
`app/catalog/caemble_catalog/catalog.sqlite3`. The worker loads active Solver
descriptors and digests at startup, then closes the database. Solver modules are
imported only on first use.

The start payload is exactly
`{ measurement: BuiltMeasurement, solverContracts }`. The contract list must
match the unique name/version/digest set referenced by Simulation manifest v5.
A mismatch is rejected before run creation.

Each kernel sees two local scopes: `experiment` for the common scene and `task`
for its task-local scene. Unit conversion modifies only that Solver view, never
the stored Geometry or frozen Material snapshot. `simulate.py` may call only
`sim.run`, `sim.record`, and `sim.release` under the API v3 AST policy.

That policy is a guardrail for trusted Experiment code, not an OS sandbox. Run
the worker under a dedicated account or container in production. API, UI, and
resident CAE workers must use the same catalog release, and workers must restart
after a catalog deployment.
