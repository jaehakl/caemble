# Develop and test an Experiment source bundle

Work in the Caemble monorepo and read AGENTS.md first. The external agent owns its model credentials; Caemble receives source bundles and authenticated API requests. Never put .env, access tokens, private keys, or unrelated workspace files in a bundle. Consult the installed CLI help for its exact flags.

1. Establish context. Record the repository revision, API origin, authenticated user, Catalog revision, Experiment ID/coordinate/version and source hash. Download the complete source bundle with its base identity before editing an existing Experiment. A source file copied from another revision is not an adequate baseline.
2. Choose a real starting point. Query the live Catalog through its Python library/catalogctl and inspect the relevant Solver descriptor and complete Example Experiment. Catalog examples are the executable reference; do not invent Solver names, versions, method IDs, material roles, output names or QuantityKind identifiers. The UI starter is a draft: its placeholder Task and no-op simulate body do not demonstrate a successful simulation.
3. Read only the needed language reference. experiment.tsx uses experiment(...); named Geometry components belong in geometry.tsx or imported local modules; material.tsx supplies Material instances; each tasks/*.tsx default-exports defineTask(...); simulate.py owns orchestration. Read the exact declarations and element reference for the props you use. TypeScript acceptance alone does not imply Caemble source-policy acceptance.
4. Keep semantics aligned. Geometry custom props require direct destructuring and defaults. Use stable geometry IDs for durable selectors. Check each element's surface slots. Match Task config and requested artifacts to the exact active Solver descriptor. Define Material models and all coefficients in material.tsx; modelGroups select one supported instance per required group on every target Material. Disambiguate with config.materialModels[role][materialName][groupKey]. Material names never load external coefficients; changing vars rebuilds model parameters. Keep RecordedData dtype, dimensions, QuantityKind, units and axes consistent with the values simulate.py will record.
5. Validate in stages. Check paths/import graph and source policy, then use the shared TypeScript compiler and local build/evaluation. Validate simulate.py with the existing CAE Python environment and program validator; Node TypeScript validation does not parse or validate Python. The Python allowlist validates the program and names, not a successful physical solution. Run relevant CAE tests locally.
6. Inspect the build. Inspect fixed variables, explicit Material model snapshots, Task identities, geometry and diagnostics. Render the structure PNG when geometry or selection changed. A preview mesh is evidence about appearance, not proof that the Solver's input, numerical method or recording contracts are correct.
7. Save with the original base identity. Refresh metadata before uploading. When source is locked or the server reports a revision conflict, fetch the current source and reconcile deliberately or create the intended new version. Do not silently overwrite or relabel another revision. Upload source and local build artifacts through their distinct contracts.
8. Test a small simulation first. Build every item locally before submitting a batch. Pin source hash and Catalog revision for the whole batch. Wait for the job's terminal state and RecordedData persistence, inspect errors and required records, then render or compute quantitative checks. Report build success, job success and recorded-result checks separately. Increase batch size only after that evidence is satisfactory.

For a failure, retain stage, message, supplied file/range, source hash and job/measurement IDs. Follow diagnostic.experiment. Do not manufacture a line number for a policy failure that reports only a message. Rebuild after source or Catalog changes. A retry should refer to the same known input, or explicitly be a new experiment condition.

Catalog data stays solely in app/catalog/caemble_catalog/catalog.sqlite3. Read it through the existing Catalog Python library; do not create a JSON/TS/Markdown copy or a separate Node SQLite adapter. User documentation is maintained as shared Markdown and displayed in Workbench Help and CLI; implementation and operations notes use the development and operations documents.

Executable command sequence (PowerShell 7, from the repository root; Node >=24.14 and the checkout's CAE Python environment installed). Run each command only after the preceding command succeeds. Choose an actual Catalog Example key from the listing; quoted REPLACE values below are user selections, not Catalog identifiers. Output directories must be empty. Configure CAEMBLE_API_URL and a caemble-scope CAEMBLE_API_TOKEN in .env for server operations.

```powershell
npm --prefix app/ui run build:cli
$caembleCli = (Resolve-Path app/ui/dist-cli/caemble.cjs).Path
node $caembleCli doctor
node $caembleCli catalog show examples
$exampleKey = 'REPLACE_WITH_LISTED_EXAMPLE_KEY'
node $caembleCli experiment init .work/experiment --example $exampleKey
node $caembleCli agent context experiment --source .work/experiment
node $caembleCli reference show experiment.contract
node $caembleCli reference show experiment.simulate
# Edit the complete source bundle, then check and retain the resulting artifact.
node $caembleCli experiment check .work/experiment --vars-mode nominal --out .work/checked
node $caembleCli png geometry .work/checked --out .work/geometry.png
node $caembleCli experiment test .work/checked --out .work/local-results --timeout 120
node $caembleCli data inspect --result .work/local-results/1
```

Both check and build run source/type checks, local input construction and the existing Python simulate.py validator. Neither starts a Solver. check accepts --out and produces the same artifact format as build, so the checked artifact above is already reusable. experiment test consumes that artifact and runs the local Solver; it creates no server batch and uploads no source. Inspect the local manifest, records and numerical expectations before continuing. Ctrl+C during test requests local cancellation and cleanup.

For an existing server Experiment, use experiment pull <id> --out <empty-directory> instead of init, then edit the pulled directory. Preserve its caemble.json baseBundleHash. For a new Experiment, choose the intended namespace/repository/key in that metadata before push. The following is an explicit server write sequence:

```powershell
node $caembleCli doctor --api
$saved = node $caembleCli experiment push .work/experiment --artifact .work/checked --json | ConvertFrom-Json
$batch = node $caembleCli batch submit .work/checked --experiment $saved.id --json | ConvertFrom-Json
node $caembleCli batch watch $batch.id
node $caembleCli batch show $batch.id
```

push stores source using its base identity and checks its matching artifact. batch submit uploads the already built item bytes and commits the remote batch; it performs no local Solver execution or rebuilding. The local test and server submission above reuse .work/checked exactly. watch emits observation events: Ctrl+C or an observation timeout leaves the remote batch running. Use batch cancel <batch-id> only when cancellation is intended. Inspect the job Measurement IDs returned by batch show with measurement inspect <measurement-id>; fetch persisted records before claiming numerical success.

To build a larger batch after the small test succeeds, use experiment build .work/experiment --count 10 --vars-mode random --out .work/batch-build, then batch submit .work/batch-build --experiment <saved-experiment-id>. All ten inputs are built and validated locally before any batch submission. Keep .work/batch-build for retry or inspection. Rebuild after changing source, variables, explicit Material model snapshots or Catalog; do not reuse an artifact with a different source or Catalog identity. For a locked source, select the intended --new-version patch|minor|major on push, then use the returned Experiment ID.
