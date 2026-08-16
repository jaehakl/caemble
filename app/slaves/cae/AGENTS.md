# CAE Solver agent instructions

Read `../../../docs/solver-development.md` completely before editing this subtree for a Solver task.

- Query and modify Solver contracts through `catalogctl` and its Draft SQLite workflow. Never use raw SQL or create a Solver `manifest.json`.
- Add physics implementation only under `app/solvers/<solver_package>/` and keep solver-specific calculations there.
- Do not add central registry branches or import Solver modules eagerly. The SQLite implementation locator is the registration mechanism.
- Treat a published `(name, version)` contract as immutable. Clone to a new version for a contract change; only the new active version remains in the catalog.
- Keep catalog identifiers literal in Experiment examples. Runtime numeric values and ordinary configuration may remain computed.
- Run the Solver unit test, registry/validation tests, a UI-exported fixture test, and the catalog validate/diff checks before publishing the Draft DB.
