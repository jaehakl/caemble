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

- `app/user_auth`: Google OAuth, cookies/JWT, CSRF, users, and access tokens.
- `app/gpstation`: `/v1` models, services, job dispatch, launcher WebSocket, and
  compatibility security utilities.
- `app/routers`: cookie-authenticated `/web` and domain endpoints.
- `app/service`: domain operations and transaction boundaries. Material CRUD
  belongs in `service/material` and its routes in `routers/material.py`.
- `app/cae`: staged artifact uploads, commit, batch events and result persistence.
- `app/utils/crud`: shared owned/public CRUD mechanics.
- `alembic`: the current destructive baseline and subsequent migrations.

The [architecture guide](architecture.md) is the concise source for
UI/API/worker responsibility. Endpoint request and
response detail belongs in Pydantic/OpenAPI definitions, not a duplicated list
in this README.

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

## Persistence boundaries

The API trusts domain payloads after basic Pydantic deserialization. Ownership,
authentication, CSRF, source/hash checks, and source-path containment
remain enforced. CAD evaluation, tensor interpretation, unit conversion, and
physics execution remain in the UI/CAE worker boundary.

QuantityKind, Material, and Solver catalog data is read from
`app/catalog/caemble_catalog/catalog.sqlite3`. Never introduce parallel catalog
data in API source, JSON, generated JavaScript, or Markdown.


### Experiment Calculation copies

`POST /experiment/save` accepts either `copyCalculationsFromExperimentId` or `calculations` on `mode: "create"`. Inline definitions contain `name`, optional nullable `description`, and `source_code`; names must be nonempty and unique within the target Experiment. A source Experiment must be readable by the caller. `new_version` automatically copies all saved Calculations from its `experimentId`; `overwrite` never adds copies. Creation of the Experiment, its Records, and its Calculations is atomic.

Copies start at revision 1 with `contract_status: "needs_preflight"`, a freshly computed source hash, and no output layout, preflight Measurement, Record links, or CalculationData. The existing Calculation upsert still requires a successful target Measurement preflight. `sourceLocked` depends only on `derivedCounts.measurements > 0`. Without Measurements, changing source or Record contracts invalidates Calculation contracts and increments their revisions; metadata-only saves preserve them.
