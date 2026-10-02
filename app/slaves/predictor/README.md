# Predictor slave

This project provides separate launcher executables for durable Forward training and model inference.
The first algorithm remains CPU NumPy kNN. Dataset files and
model artifacts live outside process memory. Releasing a model handle never deletes files.

## Protocol v3

Use the existing SDK `DataChannelMessage`, attachment transport and request cancellation.
Each request payload has `protocolVersion: 3`, `requestId: string`, and (except hello)
`sessionId: string` from hello. Responses use `<request type>.result` and preserve the
SDK message ID. Successful payloads add `protocolVersion`, `requestId`, `sessionId`.
Errors use the same result type and `{error: {code, message}}`; no local paths or tokens
are returned. An instance is `{executionId:'remote-predictor',sessionId,generation,handle}`.

```ts
type DatasetRef = { datasetId: string; revision: number; fingerprint: string };
type TrainingGrant = { operation_id: string; token: string; manifest_url: string };
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
// predictor.hello {} -> {sessionId,storageId,launcherId,algorithmDescriptors,capabilities,datasets,models}
// dataset.import {importId:string,experimentId?:number} or {grant:Grant} -> {dataset:DatasetRef & summary}
// dataset.list {} -> {datasets:summary[]}
// dataset.sync {datasetId:string,experimentId?:number} -> {dataset:DatasetRef & summary}
// dataset.preview {datasetId:string,experimentId?:number} -> {added:number,changed:number,removed:number}
// dataset.delete {datasetId:string} -> {deleted:true}
// training.pin {grant:TrainingGrant} -> {operationId,pinId}
// training.unpin {grant:TrainingGrant} -> {operationId,pinId,released:true}
// training.inspect {grant:TrainingGrant} -> {receipt,artifact}
// model.load {modelId:string,revision:number,manifestChecksum?:string} -> {...PreparedPredictionModel,artifact:Artifact}
// model.predict {instance:PredictionModelInstance,input:{direction:"forward",vars:Vars}}
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
  algorithm: string;
  definition: Record<string, unknown>; // Preserve opaque legacy definition fields.
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
`calculationData`. Rows preserve the existing recorded tensor and Measurement representation. A local
Dataset is a checked copy of that manifest and its referenced object files, imported
directly by the slave using a scoped API grant. Arbitrary master-supplied paths are
never accepted. Import replaces only the latest payload for that Dataset; existing
self-contained saved models remain usable after import or Dataset deletion.
`definition.requiredRecordIds` selects one or more frozen BoxGrid outputs. Its Experiment,
Vars schema, output contracts and preprocessing results belong to the model. Calculation
selection, targets and weights are not model configuration. Dataset Calculation assets
remain intact, but Forward preparation never decodes or requires their results.
Server Dataset grants used by training use temporary staging, which is removed after
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

## Durable training

`predictor-training` runs `app.training` using the existing server-master WebSocket runtime.
API-owned training operations freeze the Dataset revision, model definition and resources before
queue admission. Browser close never cancels accepted work. `model.prepare` is removed from the
WebRTC API; train first, then load a completed immutable revision explicitly.

For a local Dataset, `training.pin` fetches its operation-scoped authority, persists a pin, and
acknowledges it to the API before submission. Dataset sync and deletion remain blocked through
queueing, execution and process cleanup. Pins use per-attempt IDs and survive browser/process
loss. Sync/delete reconcile the scoped authority and remove pins only when cleanup is confirmed;
an unavailable API never causes an automatic unpin. Grants in pin files are excluded from archives.

A training job publishes a model artifact and durable receipt without loading an inference handle.
Retry checks for this exact completed artifact before accessing the Dataset, so loss of the
registration response never requires retraining. If no completed artifact exists, retry must
revalidate the exact Dataset revision; it never selects the latest revision implicitly.
Cancellation waits for the training thread to stop before the SDK reports process cleanup.
Progress reports loading, training, saving and saved stages; algorithms may emit structured
progress with a stage, fraction and metrics through the same callback. Checkpoint resumption
belongs to a later algorithm implementation; no incomplete artifact appears in the model list.

## Portable copies and operations

Protocol v3 is deployed together with the API and UI. Existing artifact files remain
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
size, rotation, spatial ticks and length units may differ; no spatial conversion or
interpolation is applied to the numerical cells. Dimensions, quantity and value units,
components, channels and sampled time/frequency must match. Modal output groups use the nearest Measurement,
including its modal frequency ticks. Polar values are averaged in Cartesian form.
The caller attaches predictions to the current Candidate BoxGrid, preserving the
Candidate geometry and the model/Dataset revision provenance.

Only Forward Vars-to-BoxGrid models execute. Legacy Inverse metadata remains readable
in model lists and archives; training/load/predict reject it with `unsupported-model`.
Existing Forward artifacts load without rewriting their definition or checksum.
Legacy Inverse files can still be inspected, backed up, restored or explicitly removed.
No model is automatically converted or deleted. Inverse design belongs to Optimization.

`models.py` manages immutable model artifacts and selects a Forward implementation.
`forward.py` owns kNN preparation, prediction, numerical file loading and archive validation;
`runtime.py` manages remote sessions and handles. Shared algorithm/version/resource descriptors
live in the NumPy-free `shared/prediction_contracts` package. A future algorithm implements the same
Vars-to-BoxGrid boundary without changing Dataset or process lifecycle management.

`CAEMBLE_PREDICTOR_OWNER_ID` and `CAEMBLE_PREDICTOR_API_URL` are trusted launcher
environment values required at session initialization. `CAEMBLE_PREDICTOR_STORAGE_ROOT`
optionally selects a managed root (default: user application data). A root UUID and
owner namespace prevent different installations/users from sharing identities.

Run focused tests with `python -m pytest app/slaves/predictor/tests` from the checkout.
No CAE Solver execution is required.
The checked `tests/forward_reference.json` contains fixed numerical golden results,
independent of any browser kNN implementation. It verifies neighbor order, weights,
scaling and outputs at a relative/absolute tolerance of 1e-12; dtype rounding is exact.
The tiny `tests/fixtures/legacy-forward.zip` and `legacy-inverse.zip` were produced by
the preceding artifact v1 implementation and lock byte-preserving compatibility.

The opt-in launcher test `RUN_WEBRTC_BROWSER_TESTS=1 python -m pytest tests/test_predictor_browser.py` (from `app/launcher`, after building the JS SDK)
runs real Chromium WebRTC and the small kNN fixture. It covers a fresh process loading
its saved model, prediction, production BoxGrid Viewer rendering with Candidate geometry,
optional Calculation compilation/execution in the isolated runner, release and cleanup.
A second case verifies portable backup/restore after losing the original storage.
Neither case reruns a CAE Solver.
