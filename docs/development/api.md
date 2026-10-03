# Caemble API

Commands and component-relative paths in this document are relative to `app/api`, unless stated otherwise.

The FastAPI service owns authentication, Caemble persistence, the public v1
client/launcher API, client artifact uploads, job orchestration, and catalog reads. PostgreSQL is required; the shared catalog package provides a
read-only SQLite snapshot.

## Local setup

Copy `.env.example` to `.env` and configure PostgreSQL, Google OAuth, JWT,
and allowed origins. Then install, migrate, and run:

```powershell
poetry install
poetry run alembic upgrade head
poetry run uvicorn main:app --app-dir app --reload --host 127.0.0.1 --port 8000
```

The initial migration creates the required `vector` extension. If the
application database user cannot create extensions, a DBA must create `vector`
before running Alembic.

A normal install applies the baseline and its child migrations against an empty
schema. Existing databases already stamped at the baseline advance with the
same `alembic upgrade head` command; migration-specific destructive preflight
steps are documented in `alembic/README`.

To erase every application row and recreate PostgreSQL from that baseline, run
the explicit reset entrypoint. It refuses to run unless the destructive flag is
set:

```powershell
$env:RESET_API_SCHEMA = "1"
poetry run python reset_schema.py
```

The reset drops the complete `public` schema with `CASCADE`; it does not create a
backup and the baseline does not provide downgrade recovery.

## Ownership

- `app/simulation`: Experiments, Records, Measurements, recorded results,
  execution batches, upload/preflight lifecycle, and result publication.
- `app/optimization`: Optimizations, Trials, stage submissions, the optimization
  algorithm, and build/solve/calculate coordination using GPStation Jobs.
- `app/calculation`: Calculation source, validated contracts, and CalculationData.
- `shared/catalog`: read-only Catalog queries and response schemas.
- `app/storage`: object upload, ownership, binding, and cleanup.
- `app/user_auth`: Google OAuth, cookies/JWT, CSRF, users, and Caemble access-key
  issuance and scope policy.
- `app/gpstation`: generic Jobs, Batches, execution attempts, ordered events,
  launcher connections, resource dispatch, and worker transport. It has no
  Simulation, Optimization, Catalog, or storage policy imports.
- `app/core`: shared schemas, time helpers, and CRUD mechanics. Domain packages
  supply visibility predicates and ownership rules.
- `app/gpstation_adapter.py`: the Caemble policy for existing `/web` and `/v1`
  job routes, including managed-job restrictions and Optimization filtering.
- `app/bootstrap.py`: application composition, handler registration, and the
  single owner of startup, background tasks, and shutdown. `app/main.py` remains
  the ASGI entry point.
- `app/db.py`: the shared SQLAlchemy Base, engine, sessions, and request database
  dependency. `app/model_registry.py` explicitly registers all domain models for
  application startup, Alembic, and schema reset.
- `alembic`: the current destructive baseline and subsequent migrations.

Within a domain, `db.py` contains ORM entities, `schemas.py` contains HTTP data
models, and `contracts.py` contains shared persisted artifact contracts where
needed. Routers translate HTTP inputs and delegate to services; services own SQL,
authorization decisions, and transaction boundaries. There is no parallel client
package or root model/service/route collection. Public endpoint paths and schema
names remain independent of the Python package layout.

The [architecture guide](architecture.md) is the concise source for
UI/API/worker responsibility. Endpoint request and
response detail belongs in Pydantic/OpenAPI definitions, not a duplicated list
in this README.

## Application lifecycle

`bootstrap.create_app()` registers ORM metadata and routes without opening a
database connection or starting tasks. Its lifespan opens the Catalog and
registers the Simulation and Optimization handlers before restart recovery.
Recovery fails interrupted server Jobs, then reconciles Optimizations before the
dispatcher and Optimization controller start. An initial upload-expiry sweep precedes
dispatch; a temporary sweep failure is logged and retried by Simulation's
one-second maintenance loop. Preflight and object cleanup run in a separate
minute loop.

Shutdown stops cleanup, upload maintenance, the Optimization controller, and dispatch,
then closes launcher connections, the Catalog, and the engine. The same cleanup
ownership applies when startup fails partway through. A second concurrent
lifespan for the same app is rejected.

GPStation's handler registry accepts optional `event_context` and `on_finished`
callbacks. The optimization module supplies event metadata and stage transitions
through these callbacks. A finish callback receives the existing database session
after Job and Batch terminal events; it runs in the caller's transaction, may
finish sibling Jobs, and must not commit. Callback failure rolls back domain
changes, Job state, staging cleanup, and events together. Repeated terminal
messages do not invoke it again. GPStation remains usable with generic handlers,
while this application continues to share its database and authentication models.

## Verification

The default suite checks package boundaries, the complete HTTP/OpenAPI and ORM
contract snapshot, lifecycle cleanup, and handler transaction behavior without
running a Solver or requiring PostgreSQL:

```powershell
Remove-Item Env:RUN_CAE_DB_TESTS, Env:RUN_CALCULATION_DB_TESTS, Env:RUN_PARTICLE_DB_TESTS, Env:RUN_OPTIMIZATION_E2E -ErrorAction SilentlyContinue
poetry run python -m pytest -q
```

Database tests create and drop uniquely named disposable databases. Explicitly
select a local PostgreSQL installation with `vector`; the shared test helper
rejects non-loopback hosts before connecting. For database lifecycle tests
without actual Solver execution, use a file allowlist:

```powershell
$env:DB_URL = "postgresql+asyncpg://postgres@127.0.0.1:5432/postgres"
$env:RUN_CAE_DB_TESTS = "1"
$env:RUN_CALCULATION_DB_TESTS = "1"
Remove-Item Env:RUN_OPTIMIZATION_E2E, Env:RUN_PARTICLE_DB_TESTS -ErrorAction SilentlyContinue
poetry run python -m pytest -q tests/test_calculation_database.py tests/test_cae_batches.py tests/test_optimization_controller.py tests/test_optimization_api.py tests/test_gpstation_generic_runtime.py
```

Keep the file selection explicit: `test_cae_end_to_end.py` also uses
`RUN_CAE_DB_TESTS` and starts a real Solver. Optimization end-to-end execution has its own
`RUN_OPTIMIZATION_E2E` opt-in. Neither belongs in a package-structure verification run.

### Optimization regression baseline

Run these commands from `app/api`. The default regression list uses fixed
prediction/Solver results and saved model/Training Operation metadata. It does
not connect to PostgreSQL, launch workers, or train a Predictor. It covers
verified-best selection, JSON search/RNG recovery, duplicate completion,
retry admission, and model handoff at round boundaries:

```powershell
$optimizationUnitTests = @(
    'tests/test_optimization_algorithm.py'
    'tests/test_optimization_search.py'
    'tests/test_optimization_strategies.py'
    'tests/test_optimization_de.py'
    'tests/test_hybrid_lifecycle.py'
    'tests/test_optimization_update_policy.py'
    'tests/test_optimization_versions.py'
    'tests/test_hybrid_quality.py'
    'tests/test_optimization_quality_comparison.py'
    'tests/test_optimization_model_update_lifecycle.py'
)
poetry run python -m pytest @optimizationUnitTests -q --tb=short
```

For persistence and concurrent admission, set `DB_URL` to an explicitly selected
loopback PostgreSQL server with `vector`, as above. These tests create and remove
their own databases and supply fake stage results without Solver execution or
model training. The budget cases assert that unstarted failure/cancellation
returns a reservation, started failure/cancellation retains usage, duplicate
notifications/retry requests count once, and Calculation retries reuse the
existing Measurement without another Solver run:

```powershell
$optimizationDatabaseTests = @(
    'tests/test_hybrid_optimization.py'
    'tests/test_optimization_controller.py'
    'tests/test_optimization_api.py::OptimizationPersistenceTests'
)
$previousOptimizationDbTests = $env:RUN_CAE_DB_TESTS
try {
    $env:RUN_CAE_DB_TESTS = '1'
    poetry run python -m pytest @optimizationDatabaseTests -q --tb=short
} finally {
    $env:RUN_CAE_DB_TESTS = $previousOptimizationDbTests
}
```

Keep both lists explicit. `test_optimization_model_updates.py`,
`test_optimization_automatic_updates.py`, and their fixture consumers perform
real kNN training even though they do not call a Solver; they are not part of
this inexpensive baseline.

After both lists pass, run exactly one real fixed-model Hybrid path using the
same disposable-database setup. Check the checkout CLI with `doctor` first;
if it is stale, rebuild the development CLI with `npm run build:cli` in `app/ui`
and verify it from `app/api` with
`node ../ui/dist-cli/caemble.cjs --repo ../.. doctor`. The fixture uses this
development CLI to build the example; rebuilding it does not replace the
packaged release used by the checkout wrapper.

```powershell
..\..\caemble.cmd doctor
$previousFixedHybridE2e = $env:RUN_HYBRID_E2E
try {
    $env:RUN_HYBRID_E2E = '1'
    poetry run python -m pytest tests/test_hybrid_end_to_end.py::HybridEndToEndTests::test_fixed_knn_revision_selects_real_verified_candidates_without_browser -q -s --tb=short
} finally {
    $env:RUN_HYBRID_E2E = $previousFixedHybridE2e
}
```

This uses the existing `hybrid-box-conductor@1.0.0` example: five initial-data
Solver Jobs, one initial kNN training operation, five predicted candidates,
and three Hybrid Solver verifications. The existing 180-second flow deadline
includes initial data, training, Hybrid execution, and Job/resource cleanup;
environment setup and teardown are reported separately. Acceptance also checks
saved history after reconnect, distinct prediction/verified results, and cleanup
of processes, leases, reservations, and temporary databases. Evidence is written
to `.work/hybrid-demo-acceptance.json` or `.work/hybrid-demo-last-failure.json`
at the repository root. This command does not select other Hybrid variants,
the CAE `full` suite, or all Catalog examples.

For DE acceptance, use the same disposable loopback setup and select these two
tests explicitly with `RUN_OPTIMIZATION_E2E=1` and `RUN_SEARCH_STRATEGY_E2E=1`:

```powershell
poetry run python -m pytest tests/test_optimization_end_to_end.py::OptimizationEndToEndTests::test_de_box_evolves_a_generation_and_restores_its_population tests/test_hybrid_end_to_end.py::HybridEndToEndTests::test_de_knn_evolves_with_partial_verification_and_automatic_rebuild -q -s --tb=short
```

The Solver-only case evaluates eight candidates with population four. The Hybrid
case trains on five real design points with mandatory v2 holdout, proposes twelve
candidates, verifies five, and rebuilds once with the same holdout before adopting
revision 2 at the next round. Both verify mutation and population selection beyond
initialization, actual-result-only best selection, and cleanup within each case's
180-second flow budget. Reports are `.work/de-solver-demo-acceptance.json` and
`.work/de-automatic-hybrid-demo-acceptance.json`. Restore both environment flags
after running the selected tests.

## Security and runtime boundaries

- First-party UI requests use HttpOnly cookies, `/web`, and CSRF protection.
- External clients use bearer `client` tokens and `/v1`; launchers use bearer
  `launcher` tokens on `/v1/launchers/control`.
- Access-token plaintext is returned once. The database stores only a SHA-256
  hash and display prefix.
- `caemble` keys authorize the owner's authoring, execution and data APIs. They
  never confer administrator privileges or allow key issuance/revocation.
- Python program inspection and local execution use the monorepo CAE environment;
  the API has no compiler or user-code execution endpoint.

Launcher connections and the dispatcher are held in process memory. Run exactly
one API worker/replica. Restart marks active executions failed, while committed
queued inputs and incomplete uploads remain available.

Execution protocol 3 requires a synchronized API, launcher, slave and master SDK
upgrade. A logical Job and its execution attempt are distinct. Full immutable
execution identity scopes control messages, result packets and staging; each
reconnect also gets a new control session. The dispatcher preserves owner checks,
slave compatibility and rotation between committed Batches while proposing more
than one Job to a launcher. Resource shortage is a waiting condition.

The API stores an optional `resources` request separately from domain `input`:
`cpu_cores`, `startup_ram_bytes`, `gpu_count`, and `vram_budget_gb`. Missing fields
inherit launcher application/handler profiles. GPU count defaults to one;
`gpu_count: 0` is CPU-only. `vram_budget_gb` is a positive finite GiB value
(1024³ bytes), including fractions. Old `gpu_memory_bytes` input is rejected.
An omitted budget reserves each selected GPU's whole capacity exclusively.

GPU budget sums cannot exceed each device's total bytes. Reservations persist
through cleanup, independently of current usage. Protocol-3 allocations carry
`vram_budget_bytes` keyed by GPU UUID. Reports include per-device reserved/used
bytes and per-instance usage and monitoring warnings. Budget exhaustion fails
only that attempt with `gpu_memory_budget_exceeded`; telemetry outages pause new
admissions and warn while existing jobs continue. All admission is finalized
atomically by the launcher using fresh local telemetry. Historical protocol-2
allocations remain readable; stored request budgets migrate to `vram_budget_gb`.
See [worker policy](../operations/workers.md) for observation and monitoring limits.

Launcher control reconnection has a default 30-second grace period, during which
new assignments are paused and existing instances can be reconciled. A lost
worker result WebSocket fails its attempt and requires manual retry after cleanup.
Terminal result publication and reservation release have separate barriers:
current-attempt records are published after handler completion, while the launcher
returns CPU/GPU reservations only after the full process tree exits. Previous
attempt messages cannot publish data or release the current reservation.
Launcher status exposes budgets, instance identities and waiting reasons for
inspection; resource policy editing remains local to the launcher machine.

## Persistence boundaries

The API trusts domain payloads after basic Pydantic deserialization. Ownership,
authentication, CSRF, source/hash checks, and source-path containment
remain enforced. CAD evaluation, tensor interpretation, unit conversion, and
physics execution remain in the UI/CAE worker boundary.

QuantityKind, Material, and Solver catalog data is read from
`shared/catalog/caemble_catalog/catalog.sqlite3`. Never introduce parallel catalog
data in API source, JSON, generated JavaScript, or Markdown.


### Experiment Calculation copies

`POST /experiment/save` accepts either `copyCalculationsFromExperimentId` or `calculations` on `mode: "create"`. Inline definitions contain `name`, optional nullable `description`, and `source_code`; names must be nonempty and unique within the target Experiment. A source Experiment must be readable by the caller. `new_version` automatically copies all saved Calculations from its `experimentId`; `overwrite` never adds copies. Creation of the Experiment, its Records, and its Calculations is atomic.

Copies start at revision 1 with `contract_status: "needs_preflight"`, a freshly computed source hash, and no output layout, preflight Measurement, Record links, or CalculationData. The existing Calculation upsert still requires a successful target Measurement preflight. `sourceLocked` depends only on `derivedCounts.measurements > 0`. Without Measurements, changing source or Record contracts invalidates Calculation contracts and increments their revisions; metadata-only saves preserve them.
