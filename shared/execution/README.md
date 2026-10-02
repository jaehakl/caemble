# Shared execution

`@caemble/execution` is the private TypeScript package used by the browser,
CLI, and Evaluation worker. Install the repository's npm workspaces with
`npm ci` at the repository root.

- `src/cad`, `src/cae`, and `src/calculation` contain platform-independent
  authoring, Measurement build, and Calculation contracts and execution code.
- `src/contracts`, `src/catalog`, `src/material`, `src/quantitykind`, and
  `src/prediction` provide the data contracts and runtime support those modules
  require. Catalog data remains in `shared/catalog/caemble_catalog/catalog.sqlite3`.
- `src/node` provides Node compilation, local execution, and Evaluation adapters.
  Import these only from CLI or Node entrypoints.
- `scripts/node_runtime.py` prepares the immutable `node/` release bundle under
  `.data/node-runtime`; `scripts/cli-bootstrap.cjs` loads the selected CLI bundle.

Consumers import explicit subpaths, such as
`@caemble/execution/cad/model` or `@caemble/execution/node/evaluation`.
Browser Workers, iframe connections, Monaco, rendering, and application state
remain in `app/ui`. Shared source must not import that application.

Run `npm run check --workspace @caemble/execution` for TypeScript checks.
The UI's `check:dependencies`, `test:unit`, and `build-ui` commands include the
shared source and enforce the browser/Node boundary. Shared unit tests and UI
integration tests exercise the same implementation.
