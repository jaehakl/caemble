# Develop and validate a Calculation

1. Resolve the target before writing code. Read the ExperimentRecord catalog, Calculation source/base hash if editing, the selected recorded Measurement and the records actually available for it. Names are dotted leaf paths; a record schema does not establish that its data exists in every Measurement.
2. Read calculation.contract and calculation.declarations. The language is JavaScript with optional JSDoc, exactly one synchronous default-exported function declaration and one identifier parameter. Use only named imports from the shipped Math.js manifest. Do not write TypeScript annotations, an arrow default export, an async function, dynamic imports or general Node/browser code. Some Math.js declaration signatures intentionally use any; runtime shape and numerical behavior still require execution.
3. Declare dependencies in the source. Read record.signal or record['group.signal']; use fixed object destructuring or traceable const aliases. Do not enumerate or spread the whole input, pass it to a helper, or choose a record name dynamically. Dynamic numeric indexes inside a leaf array are a different operation; runtime requires non-negative safe integers. Dependency analysis must use the actual available ExperimentRecord names.
4. Export a complete input snapshot for reproducibility. Preserve dtype, shape, flat/scalar data, complete axes/ticks, tensorOrder, quantityKind and unit as applicable. Keep Experiment/Measurement/RecordedData IDs, source hash, Catalog revision and content hashes in a separate provenance envelope. A sample or truncated preview is not an executable complete snapshot. An already-normalized snapshot can execute offline without a Catalog adapter; its resolved tensorOrder must not be guessed from shape.
5. Start from a validated complete example. The synthetic examples here each provide full calculation.js, input and expected output. Replace their fixed 'signal' dependency with an actual name and choose numerical assumptions explicitly. A string/bool input may require a meaningful conversion or rejection; silently coercing every dataset can hide invalid science.
6. Run all layers. Source policy and dependency analysis catch different errors. Type-check against the exact shipped declarations. Execute the common compiled runtime in the CLI's disposable child with bounded time and logs. Check dtype, finite output, inferred rank/shape, numeric axes and units, and assert expected numerical values for at least one relevant fixture. Re-run with the actual server input snapshot before persistence.
7. Inspect the result. Scalar output has no axes; rank one renders a line; rank two renders a heatmap. Verify orientation, ordering and dimensions using the normalized output, then inspect its PNG. Output must be finite real rank 0/1/2 data; ragged arrays, complex final values and an explicit shape field are rejected. Input rank can be higher and needs deliberate reduction.
8. Save the right contract. A source-changing save requires successful preflight with the selected server data. Preserve the source hash, exact dependency list and dtype/shape/axes layout from that run. Offline synthetic success is test evidence, not permission to invent a server preflight. For a base-source conflict, fetch and reconcile the current record or save the intended new Calculation. Persist results only for the corresponding Calculation source and Measurement.

Report fixture identity/hash, source hash, dependency names, compile/run status, output layout, numerical assertions and bounded logs. Follow diagnostic.calculation for policy, compilation, input, runtime, timeout and output failures. Do not call a timeout or an invalid output a successful calculation. Execution belongs in a disposable process; the shared function alone does not supply a process timeout.

Executable synthetic test (PowerShell 7, from the repository root; use an empty .work/calculation directory). reference show returns a structured example field with the exact source, complete input and expected normalized output used by the automated tests. Write UTF-8 without a BOM:

```powershell
npm --prefix app/ui run build:cli
$caembleCli = (Resolve-Path app/ui/dist-cli/caemble.cjs).Path
node $caembleCli calculation init .work/calculation
$example = node $caembleCli reference show calculation.example.mean --json | ConvertFrom-Json
Set-Content -LiteralPath .work/calculation/calculation.js -Value $example.example.source -Encoding utf8NoBOM -NoNewline
$example.example.input | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath .work/calculation/input.json -Encoding utf8NoBOM
node $caembleCli calculation check .work/calculation/calculation.js
$fixtureRun = node $caembleCli calculation run .work/calculation/calculation.js --fixture .work/calculation/input.json --out .work/fixture-result.json --json | ConvertFrom-Json
if ($fixtureRun.output.data -ne $example.example.expected.data) { throw 'Synthetic mean fixture failed.' }
```

The mean fixture expects the scalar 5. The line and heatmap references have their own full source/input/expected values. check applies source policy and JavaScript/JSDoc type checks without execution. run also resolves fixed dependencies against the selected input, executes with a timeout and validates output. Neither command saves a Calculation or CalculationData.

For a real local simulation result, inspect its actual record contract first. Update the source to use those exact record names and physically meaningful operations; the synthetic 'signal' name is not a promised Catalog output:

```powershell
node $caembleCli data inspect --result .work/local-results/1
node $caembleCli agent context calculation --source .work/calculation --result .work/local-results/1
# Edit calculation.js for these records and assert the expected numerical result.
node $caembleCli calculation run .work/calculation/calculation.js --result .work/local-results/1 --out .work/local-calculation.json
node $caembleCli png calculation .work/local-calculation.json --out .work/local-calculation.png
node $caembleCli data export --result .work/local-results/1 --out .work/result-export
```

The local data export directory contains the Record values, binary attachments and exact built input with its source bundle and hashes. It remains readable after moving the complete directory: use --result with that directory for inspect, slice, Calculation or PNG. Export does not rebuild or run a Solver.

For a server Measurement, select IDs from experiment list and completed batch/Measurement metadata; do not substitute arbitrary IDs. Configure the API .env and run doctor --api. When editing an existing Calculation, first calculation pull <id> --out <empty-directory> and retain its revision in caemble.json.

```powershell
$experimentId = 'REPLACE_WITH_SERVER_EXPERIMENT_ID'
$measurementId = 'REPLACE_WITH_RECORDED_MEASUREMENT_ID'
node $caembleCli agent context calculation --source .work/calculation --experiment $experimentId --measurement $measurementId
node $caembleCli calculation run .work/calculation/calculation.js --measurement $measurementId --out .work/server-calculation.json
node $caembleCli calculation run .work/server-calculation.json.source.js --fixture .work/server-calculation.json.input.json --out .work/replay.json
node $caembleCli calculation push .work/calculation --experiment $experimentId --measurement $measurementId
```

Each run with --out writes the result envelope plus adjacent .input.json and .source.js files. Keep all three: source_hash identifies the exact saved source bytes, input_hash identifies the serialized complete normalized input, and provenance records the selected fixture, local result or remote Measurement. Compare source_hash, input_hash and output between the server capture and offline replay before treating them as the same computation. The replay uses the captured source file even if the editable draft has changed. A fixture alone has no remote provenance; retain the original result envelope with it.

push is a server write and performs a fresh preflight using the required server --measurement; offline success cannot replace this step. The Measurement must belong to the target Experiment and have recorded data. A stale revision returns a conflict: pull/reconcile before saving again. To persist calculated results for saved Calculation/Measurement pairs, inspect calculation-data missing --experiment <id> first, then explicitly calculation-data run --experiment <id> --calculation <id> --measurement <id>. This last command writes CalculationData.

## Complex RecordedData

`complex64` input elements are Math.js Complex values inside the Calculation.
An offline JSON snapshot retains each element as `{ re, im }`; execution restores
Math.js Complex without changing the logical shape. Import `re`, `im`, `abs` or
`arg` from `mathjs` to produce a finite real chart/table output explicitly.
`Number(complex)` is not a real-part conversion. A zero-amplitude phase is undefined.
For spectral fields select the requested sample using recorded frequency-axis ticks,
not a wavelength embedded in the result name. The current Gold FCC Catalog example
includes two Fresnel Calculations using this selection on the same three records.
