# Develop a Solver in the existing CAE architecture

Read docs/development/solver-development.md and app/slaves/cae/AGENTS.md completely before changing a Solver. Those live files are authoritative; this guide is a navigation and verification checklist, not a replacement ABI or a second Catalog.

1. Inspect an existing implementation, its numerical methods, tests and live Solver descriptor. Query Catalog data using the existing Python Catalog library or catalogctl. Capture the intended physical equations, units, domains, boundary conditions, expected observables and numerical tolerances before editing.
2. Use a separate Draft SQLite and explicitly pass its path to every catalogctl mutation. Create or clone the Solver's SemVer through catalogctl; published name/version contracts are immutable. Do not use raw SQL, a Node SQLite adapter, a Solver manifest.json, a central registry branch or duplicated Catalog data. The CAE and AI launcher manifests remain launcher executable contracts.
3. Declare each Material role's supported model groups in the Solver descriptor. Groups are combined with AND and each group selects exactly one compatible model instance. Model definitions own parameter structure, units and conventions; Solver code owns the numerical implementation. Do not look up coefficients by Material name or duplicate a model schema in the Solver descriptor.
4. Implement ABI 3 under app/slaves/cae/app/solvers/<package>/entry.py, with solver-specific domain/formulation/output code nearby. Compose existing methods with explicit values. Preserve kernel.api <- methods <- solvers. The resident coordinator must not eagerly import Solver code; Catalog locators are loaded in the spawned child.
5. Return SolverResult with state_patch, requested typed artifacts and declared observations. Treat invocation input state as immutable; do not expose Runtime ResourceRef in Solver inputs or outputs. Preserve domain identity, units and provenance. Different grids with equal shape are not automatically the same physical domain. Follow the existing coupling methods and their supported domains.
6. Let simulate.py retain orchestration through sim.run, sim.record and sim.release. Respect task ownership, cancellation, progress, child lifecycle and recording ACK/resource release. Use the real CAE Python validator and tests locally. Do not generate a second Python grammar or add an API-only syntax-check path.
7. Add or update a complete executable Example Experiment in the Catalog Draft: literal active Solver name/version and method IDs, geometry/material bindings, outputs, recording schema, units and axes. Use the same integrated Node build path as the CLI/UI through the CAE build adapter, with the Draft explicitly selected where required. Do not keep the old standalone prepare implementation as a parallel compiler.
8. Validate the Draft descriptors and build its complete Examples without running a Solver. Local execution uses the canonical Catalog: explicitly publish the intended Draft to canonical SQLite through catalogctl, then rebuild against canonical and use fresh Python processes for execution. The CLI never publishes or redirects Catalog identities automatically. Reconcile all examples against the new active Solver version before removing the old Catalog version.
9. Run focused numerical tests, CPU integration and Catalog example build/run checks against that canonical revision. Include boundary/error conditions relevant to the change; do not widen tolerances to obtain a pass. If resource/lifecycle boundaries changed, test cancellation/crash rollback, foreign/released handles, artifact contracts and mmap/child cleanup. Inspect geometry and quantitative output with the CLI's render and Calculation tools. Report CUDA skip separately from a successful GPU test, and coordinate API/UI/CAE deployment with the same tested Catalog release. Old user Experiments are not silently redirected to another Solver version.

Finish with the implementation and Catalog changes, Example identity, actual commands/checks run, numerical evidence, source/Catalog hashes and any untested device-specific behavior. Keep user-facing reference in Workbench Help and architecture/operations in development documentation.

Command sequence (PowerShell 7, repository root). Read both required files completely; agent context returns their exact checkout text/hash within its explicit budget. The focused tests and physical tolerances still come from the changed implementation.

```powershell
Get-Content -LiteralPath docs/development/solver-development.md -Encoding UTF8
Get-Content -LiteralPath app/slaves/cae/AGENTS.md -Encoding UTF8
npm --prefix app/ui run build:cli
$caembleCli = (Resolve-Path app/ui/dist-cli/caemble.cjs).Path
node $caembleCli doctor
node $caembleCli agent context solver
Push-Location app/catalog
$catalog = 'caemble_catalog/catalog.sqlite3'
$draft = '.catalog-work/solver-development.sqlite3'
poetry run catalogctl --database $draft draft create --source $catalog
poetry run catalogctl --database $draft query solver
Pop-Location
```

Apply the documented solver create/clone, typed config/output/input and Example mutations to that Draft, always with --database. Read the live Catalog CLI help for the specific descriptor command; the guide deliberately does not invent a Solver identity or duplicate Catalog rows. Edit implementation and tests in the checkout. Then choose the newly authored Example:

```powershell
$draftCatalog = (Resolve-Path app/catalog/.catalog-work/solver-development.sqlite3).Path
node $caembleCli catalog show examples --catalog $draftCatalog
$exampleKey = 'REPLACE_WITH_DRAFT_EXAMPLE_KEY'
node $caembleCli experiment build --example $exampleKey --catalog $draftCatalog --vars-mode nominal --out .work/draft-build
```

The Draft build checks declarations, policy, input construction and simulate.py validation only; it is not a numerical test. Inspect its diagnostics and frozen inputs. Publishing below is an explicit change to the canonical Catalog, performed only for the intended validated Draft:

```powershell
Push-Location app/catalog
poetry run catalogctl --database $draft publish --destination $catalog
Pop-Location
node $caembleCli doctor
node $caembleCli experiment build --example $exampleKey --vars-mode nominal --out .work/solver-build
node $caembleCli experiment test .work/solver-build --out .work/solver-results --timeout 120
node $caembleCli data inspect --result .work/solver-results/1
Push-Location app/slaves/cae
poetry run python -m pytest tests -m "not cuda"
poetry run python -m pytest tests/test_fdtd_cuda.py -m cuda
Pop-Location
```

Do not execute .work/draft-build against a different canonical revision. After publish, the canonical rebuild above makes the active identity explicit. CPU integration fixtures invoke the same CLI experiment build to create inputs; the Python test harness then runs Solver children and asserts numerical/resource behavior. A pytest fixture must not call experiment test or recursively start pytest. The standalone experiment test above is a separate user command and submits no remote jobs. Keep its manifest and record data with source/Catalog hashes, and use the Calculation guide to create quantitative assertions and reproducible plots.
