# Caemble API

The FastAPI service owns authentication, Caemble persistence, the public v1
client/launcher API, job orchestration, catalog reads, and staged AI Agent
sessions. PostgreSQL is required; the shared catalog package provides a
read-only SQLite snapshot.

## Local setup

Copy `.env.example` to `.env` and configure PostgreSQL, Google OAuth, JWT,
allowed origins, and credential-encryption keys. Then install, migrate, and run:

```powershell
poetry install
poetry run alembic upgrade head
poetry run alembic current
poetry run uvicorn main:app --app-dir app --reload --host 127.0.0.1 --port 8000
```

The initial migration creates the required `vector` extension. If the
application database user cannot create extensions, a DBA must create `vector`
before running Alembic.

Routine tests omit explicitly slow database/WebSocket contracts and opt-in live
provider checks:

```powershell
poetry run pytest -q -m "not slow and not live"
```

Run the complete local suite before a cross-boundary change is merged:

```powershell
poetry run pytest -q
```

The live OpenAI smoke test is separate, uses the environment variables named in
the test module, sends a paid request, and must never run in routine CI.

## Ownership

- `app/user_auth`: Google OAuth, cookies/JWT, CSRF, users, and access tokens.
- `app/gpstation`: `/v1` models, services, job dispatch, launcher WebSocket, and
  compatibility security utilities.
- `app/routers`: cookie-authenticated `/web` and domain endpoints.
- `app/service`: domain operations and transaction boundaries. Material CRUD
  belongs in `service/material` and its routes in `routers/material.py`.
- `app/ai`: external provider credentials, Agent tools, staged source changes,
  and streaming run state.
- `app/utils/crud`: shared owned/public CRUD mechanics.
- `alembic`: append-only schema migrations.

The [architecture guide](../../docs/architecture.md) is the concise source for
current bundle versions and UI/API/worker responsibility. Endpoint request and
response detail belongs in Pydantic/OpenAPI definitions, not a duplicated list
in this README.

## Security and runtime boundaries

- First-party UI requests use HttpOnly cookies, `/web`, and CSRF protection.
- External clients use bearer `client` tokens and `/v1`; launchers use bearer
  `launcher` tokens on `/v1/launchers/control`.
- Access-token plaintext is returned once. The database stores only a SHA-256
  hash and display prefix.
- User provider keys are encrypted with the ordered MultiFernet keys in
  `AI_CREDENTIAL_FERNET_KEYS` and are never returned after registration.
- Agent input may include source and Visible DB/catalog data selected for the
  current user. Compile/evaluate output is not sent automatically.

OpenAI Responses requests set `store=false` and request implicit prompt caching
with a 30-minute TTL. This disables retrievable response state for those
requests, but it is not Zero Data Retention: OpenAI's default abuse-monitoring
logs may retain customer content for up to 30 days, and prompt-cache application
state can have a longer provider-side maximum than the requested application
TTL. See the [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)
and the production disclosure in [deployment](../../deployment/deployment.md).

Launcher connections, the dispatcher, and active Agent sessions are held in
process memory. Run exactly one API worker/replica. A restart marks active jobs
failed and does not resume an Agent run.

## Persistence boundaries

The API validates source hashes, ownership, immutable Geometry imports, and
one-time RecordedData attachment. CAD evaluation, tensor interpretation, unit
conversion, and physics execution remain in the UI/CAE worker boundary.

QuantityKind, Material, and Solver catalog data is read from
`app/catalog/caemble_catalog/catalog.sqlite3`. Never introduce parallel catalog
data in API source, JSON, generated JavaScript, or Markdown.
