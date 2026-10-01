# Predictor slave

This launcher executable prepares and persists CPU NumPy kNN models. Dataset files and
model artifacts live outside process memory. Releasing a model handle never deletes files.

## Protocol v1

Use the existing SDK `DataChannelMessage`, attachment transport and request cancellation.
Each request payload has `protocolVersion: 1`, `requestId: string`, and (except hello)
`sessionId: string` from hello. Responses use `<request type>.result` and preserve the
SDK message ID. Successful payloads add `protocolVersion`, `requestId`, `sessionId`.
Errors use the same result type and `{error: {code, message}}`; no local paths or tokens
are returned. An instance is `{executionId:'remote-knn',sessionId,generation,handle}`.

```ts
type DatasetRef = { datasetId: string; revision: number; fingerprint: string }
type Grant = {
  manifest_url: string; object_url_template: string; token: string;
  dataset_id: string; revision: number; fingerprint: string;
  manifest_sha256: string; expires_at?: string | number;
  grant_id?: string; refresh_url?: string
}
type Prepare = {
  dataset: DatasetRef | { grant: Grant };
  direction: 'forward' | 'inverse';
  definition: PredictionModelDefinition;
  model: { modelId: string; revision: number; operationId: string; name: string }
}
// predictor.hello {} -> {sessionId,storageId,launcherId,implementationVersion,
//   preprocessingVersion,capabilities,datasets,models}
// dataset.import {importId:string,experimentId?:number} or {grant:Grant} -> {dataset:DatasetRef & summary}
// dataset.list {} -> {datasets:summary[]}
// dataset.sync {datasetId:string,experimentId?:number} -> {dataset:DatasetRef & summary}
// dataset.delete {datasetId:string} -> {deleted:true}
// model.prepare Prepare -> {...PreparedPredictionModel,artifact:Artifact}
// model.load {modelId:string,revision:number,manifestChecksum?:string} -> {...PreparedPredictionModel,artifact:Artifact}
// model.predict {instance:PredictionModelInstance,input:PredictionInput}
//   -> {...PredictionExecutionResult,provenance:{modelId,modelRevision,datasetId,datasetRevision}}
// model.release {instance:PredictionModelInstance} -> {released:true}
// model.list {} -> {models:Artifact[]}
// model.delete {modelId:string,revision?:number} -> {deleted:true}
type Artifact = {
  modelId:string; revision:number; operationId:string; name:string;
  direction:'forward'|'inverse'; algorithm:'knn'; definition:PredictionModelDefinition;
  datasetId:string; datasetRevision:number; datasetFingerprint:string;
  storageId:string; launcherId:string; manifestChecksum:string; formatVersion:1;
  files:{name:string;sha256:string;byteLength:number}[];
  profile:PredictionModelProfile; inputLayouts:PredictionTensorLayout[];
  outputLayouts:PredictionTensorLayout[]
}
```

The direction-neutral Dataset manifest is `kind: 'caemble.prediction.dataset', version: 1`
with `datasetId`, `revision`, `fingerprint`, `experimentId`, `sourceHash`, `measurements`,
`varsSchema`, `records`, `recorded`, `rules`, `resultContracts`, `calculations`, and
`calculationData`. Rows use the existing TrainingSnapshot representation. A local
Dataset is a checked copy of that manifest and its referenced object files, imported
directly by the slave using a scoped API grant. Arbitrary master-supplied paths are
never accepted. Import replaces only the latest payload for that Dataset; existing
self-contained saved models remain usable after import or Dataset deletion.
`definition.calculationIds` and `definition.requiredRecordIds` select a frozen subset
for a model; those contracts and preprocessing results are retained in its artifact.
Server grants passed to `model.prepare` use temporary staging, which is removed after
loading; they do not create persistent local Dataset caches.
Expiring grants renew through their pinned revision's `refresh_url` with the scoped
bearer only. A 401 retries once after renewal. The returned revision, manifest hash,
grant identity, and URLs must remain unchanged; a released/retired grant stops the
transfer. Tokens remain in process memory and never enter Dataset/model artifacts.

A portable local bundle contains `dataset.json`, referenced raw `<sha256>.object`
files, and `manifest.json` with `kind: 'caemble.prediction.dataset.artifact', version:1`,
`identity`, `revision`, `metadata`, and checksummed `files`. Stage that directory at
`<root>/owners/<SHA256(owner ID UTF-8)>/imports/<importId>`, then call `dataset.import`
with its opaque import ID. The SDK/CLI may export a bundle; the browser never sends a
filesystem path. Import creates a separate local Dataset UUID, preserving its source
Dataset identity/revision in `origin` and its content fingerprint. Its identity is
stable for that storage, owner, and import ID. Repeating the same contents is idempotent.
To synchronize, export the updated source Dataset into the same import directory and
explicitly call `dataset.sync`; additions/removals are reflected in a new local revision,
while unchanged content is a no-op. Only the latest local payload is retained. Summaries
include a stable `operationId` for retrying API registration after an interrupted response.
Retired revisions retain only small registration receipts. `hello.datasets` lists those
receipts in ascending revision order before the latest payload, with
`registrationReceipt:true,payloadAvailable:false`, so missed API registrations can be
replayed without retaining old Dataset tensors.
A deleted Dataset cannot be revived by a stale import; choose a new import ID to create
a new local Dataset from the same source.
The Workbench supplies `experimentId` to reject an import or sync from another Experiment
before publishing it.

Owner-scoped native file locks serialize preparation, loading, synchronization and
cleanup across Predictor processes. In-memory prediction does not take that lock.
Every loaded model handle holds a small PID/process-start lease; deletion is rejected
until all live sessions release their handles. Leases from terminated processes are
pruned when deletion is retried, so restarting a launcher does not strand its files.

## Numerical contract

Forward uses Vars range scaling and matching Box relative cell indices. Spatial origin,
size and rotation may differ; dimensions, quantity, units, components, channels and
sampled time/frequency must match. Modal output groups use the nearest Measurement,
including its modal frequency ticks. Polar values are averaged in Cartesian form.
The caller attaches predictions to the Candidate Box Grid, as in browser execution.

Inverse uses Calculation tensors, population standard deviations, per-block weights
and active cell normalization, and clamps output Vars to their declared bounds.
Calculation dtype, shape, axis name and unit must match the frozen Calculation
contract; per-Measurement ticks remain ordinal correspondence. Missing/null/nonfinite
values exclude the complete sample with a diagnostic. No zero imputation or unit
conversion is performed. Ties use Measurement ID; all exact matches share equal weight.

`CAEMBLE_PREDICTOR_OWNER_ID` and `CAEMBLE_PREDICTOR_API_URL` are trusted launcher
environment values required at session initialization. `CAEMBLE_PREDICTOR_STORAGE_ROOT`
optionally selects a managed root (default: user application data). A root UUID and
owner namespace prevent different installations/users from sharing identities.

Run focused tests with `python -m pytest app/slaves/predictor/tests` from the checkout.
No CAE Solver execution is required.
The checked `tests/browser_reference.json` fixture is generated by
`tests/browser_reference.ts` using the actual browser kNN implementation. It compares
neighbor order, weights, scaling and outputs at a relative/absolute tolerance of 1e-12.
