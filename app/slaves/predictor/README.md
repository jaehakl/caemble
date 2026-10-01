# Predictor slave

This launcher executable prepares and persists CPU NumPy kNN models. Dataset files and
model artifacts live outside process memory. Releasing a model handle never deletes files.

## Protocol v2

Use the existing SDK `DataChannelMessage`, attachment transport and request cancellation.
Each request payload has `protocolVersion: 2`, `requestId: string`, and (except hello)
`sessionId: string` from hello. Responses use `<request type>.result` and preserve the
SDK message ID. Successful payloads add `protocolVersion`, `requestId`, `sessionId`.
Errors use the same result type and `{error: {code, message}}`; no local paths or tokens
are returned. An instance is `{executionId:'remote-knn',sessionId,generation,handle}`.

```ts
type DatasetRef = { datasetId: string; revision: number; fingerprint: string };
type Grant = {
  manifest_url: string;
  object_url_template: string;
  token: string;
  dataset_id: string;
  revision: number;
  fingerprint: string;
  manifest_sha256: string;
  expires_at?: string | number;
  grant_id?: string;
  refresh_url?: string;
};
type Prepare = {
  dataset: DatasetRef | { grant: Grant };
  direction: "forward" | "inverse";
  definition: PredictionModelDefinition;
  model: {
    modelId: string;
    revision: number;
    operationId: string;
    name: string;
  };
};
// predictor.hello {} -> {sessionId,storageId,launcherId,implementationVersion,
//   preprocessingVersion,capabilities,datasets,models}
// dataset.import {importId:string,experimentId?:number} or {grant:Grant} -> {dataset:DatasetRef & summary}
// dataset.list {} -> {datasets:summary[]}
// dataset.sync {datasetId:string,experimentId?:number} -> {dataset:DatasetRef & summary}
// dataset.preview {datasetId:string,experimentId?:number} -> {added:number,changed:number,removed:number}
// dataset.delete {datasetId:string} -> {deleted:true}
// model.prepare Prepare -> {...PreparedPredictionModel,artifact:Artifact}
// model.load {modelId:string,revision:number,manifestChecksum?:string} -> {...PreparedPredictionModel,artifact:Artifact}
// model.predict {instance:PredictionModelInstance,input:PredictionInput}
//   -> {...PredictionExecutionResult,provenance:{modelId,modelRevision,datasetId,datasetRevision}}
// model.release {instance:PredictionModelInstance} -> {released:true}
// model.list {} -> {models:Artifact[]}
// model.delete {modelId:string,revision?:number} -> {deleted:true}
type Artifact = {
  modelId: string;
  revision: number;
  operationId: string;
  name: string;
  direction: "forward" | "inverse";
  algorithm: "knn";
  definition: PredictionModelDefinition;
  datasetId: string;
  datasetRevision: number;
  datasetFingerprint: string;
  storageId: string;
  launcherId: string;
  manifestChecksum: string;
  formatVersion: 1;
  files: { name: string; sha256: string; byteLength: number }[];
  profile: PredictionModelProfile;
  inputLayouts: PredictionTensorLayout[];
  outputLayouts: PredictionTensorLayout[];
};
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

Owner-scoped native file locks protect publication, pointer updates and cleanup.
Model preparation, loading and portable transfers hold revision read leases while
doing long reads; their hashing and network transfer do not hold the owner lock.
Independent operation locks serialize retries of the same operation across processes.
In-memory prediction does not take the disk lock.
Every loaded model handle holds a small PID/process-start lease; deletion is rejected
until all live sessions release their handles. Leases from terminated processes are
pruned when deletion is retried, so restarting a launcher does not strand its files.

## Portable copies and operations

Protocol v2 is deployed together with the API and UI. Existing artifact files remain
format v1 and are preserved byte for byte. A portable archive is a deterministic
`ZIP_STORED` file containing `package.json`, the original `manifest.json`, and the
manifest's exact file inventory. Model and optional Dataset use separate archives,
so deleting a Dataset copy does not require rewriting its model backup.
Archive inspection rejects extra/duplicate/case-colliding paths, links, compressed
or encrypted entries, unknown versions, mismatched hashes and invalid NumPy headers.
NumPy loading never enables pickle. Storage identity, leases, process handles and
grants are excluded from the archive.

Management uses a separate short-lived Predictor job and the existing SDK. The
browser sends only scoped operation grants and metadata; the slave streams checked
8 MiB object chunks directly through API-issued storage URLs. Account credentials
and local filesystem paths are never accepted. API metadata lists need no job.

```ts
// artifact.backup {operationId, grant, model:{modelId,revision,manifestChecksum},
//   includeDataset, slots?:('model'|'dataset')[],
//   datasetSource?:{local:DatasetRef}|{grant:Grant}|{backup:OperationGrant}}
// artifact.restore {operationId, grant}
// artifact.remove {operationId, grant, replicaId, kind:'model'|'dataset',identity,revision}
// artifact.verify {kind:'model'|'dataset',identity,revision,manifestChecksum?}
//   -> {state:'present'|'missing'|'corrupt',artifact?,storageId,launcherId,error?}
// operation.inspect {operationId,grant?} -> {receipt:OperationReceipt|null,operation?}
```

Backup and restore return `{receipt, operation}`. Durable receipts record completed
files separately from API registration; interrupted registration retries use the
same operation and revision without retraining. Completed backup archives are kept
locally until cloud registration succeeds, then removed from the operation staging
area. A stopped process leaves recoverable staging that the next retry cleans.
Inspection with the same operation grant reconciles registration and removes staged
archives on both participants after a backup sourced from two launchers completes.
Management cancellation belongs to its dedicated job and never releases unrelated
prediction instances. Panel close does not cancel that job.

Normal Dataset synchronization still retains only the latest payload. Explicitly
restored revisions have independent retention markers and remain usable without
changing a newer latest pointer. `artifact.remove` removes only the authorized copy
and leaves no logical deletion tombstone, so an active revision can later be restored
again. `dataset.import` continues to create a new identity; it is not restoration.
`hello` and list responses inspect metadata and lengths with `verified:false`;
`artifact.verify` performs explicit complete checksum verification.

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
