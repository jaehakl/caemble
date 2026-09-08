# CAE Solver agent instructions

Read `../../../docs/development/solver-development.md` completely before editing this subtree for a Solver task.

- Query and modify Solver contracts through `catalogctl --database <draft>` and its Draft SQLite workflow. Never use raw SQL or create a Solver `manifest.json`.
- Add physics implementation only under `app/solvers/<solver_package>/` and keep solver-specific calculations there.
- Do not add central registry branches or import Solver modules eagerly. The SQLite implementation locator is the registration mechanism.
- Treat a published `(name, version)` contract as immutable. Clone to a new version for a contract change; only the new active version remains in the catalog. Keep implementation code at `app/solvers/<solver_package>/entry.py`; use Git for old code, not version directories or compatibility adapters.
- Support ABI 3 only. Rewrite official examples for the active Solver versions and remove prior catalog examples. Removed Solver identities must fail explicitly; never redirect old Experiments.
- Keep runtime orchestration, resources, catalog access, and transport under `app/kernel/`. Keep only `__init__.py` and the thin `__main__.py` entry point directly under `app/`.
- Keep catalog identifiers literal in Experiment examples. Runtime numeric values and ordinary configuration may remain computed.
- Validate explicit Material model parameters with the shared Catalog Python schema validator and resolve each Task material role/model group before execution. Do not add unrelated business, geometry, resource validators or explicit resource caps to this worker. Material names never trigger external coefficient lookup or sampling.
- Keep unit conversion, geometry/voxel transformations, numerical methods, and natural runtime failures. Preserve the Python AST allowlist, run/job ownership, ACK/release lifecycle, and physical ray-tracing state transitions including adaptive multilayer behavior.
