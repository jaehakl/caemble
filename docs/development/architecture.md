# Caemble architecture

Caemble is a local-first CAE Workbench. The browser authors and previews an
Experiment, the API owns persistence and orchestration, and a per-user launcher
runs isolated worker applications. Workbench Help is the user manual;
this document describes the implementation boundaries.

## Identities and payloads

Experiment and Solver SemVer are durable identities. An Experiment is addressed
by namespace, repository, tag, and SemVer; a Solver is addressed by name and
SemVer. Published identities are immutable, so a behavior or descriptor change
gets a new SemVer. The official Catalog contains one current version per Solver
name and current examples. Old user Experiments are not rewritten or redirected:
removed Solver versions fail lookup. Git preserves prior code and Catalog releases.

CAD source, Geometry scenes, Simulation programs, Material snapshots, Catalog
slices, and built Measurements have separate responsibilities. BuildArtifact v2
retains release, source and input hashes at the client/API boundary. Solver ABI 3
receives explicit Material model instances and the selected instance for each
required model group. The shared model input validator checks structure, units
and declared ranges; the Solver owns numerical preparation and computation.
Geometry transformations affect only the Solver view.

QuantityKind, Material Model, Solver, and Experiment catalog records live only in
`app/catalog/caemble_catalog/catalog.sqlite3`. Launcher `manifest.json` files
describe executables and are not Solver descriptors.

## Experiment data flow

1. The Workbench loads an immutable Experiment identity and evaluates its CAD
   source in the isolated browser runner.
2. Evaluation produces the common Geometry scene and any task-local Geometry.
   Preview meshes are render products, not solver input.
3. Each evaluation constructs Experiment-local Material model instances from
   explicit parameters and Vars. Model schemas normalize those inputs, and each
   Task selects compatible instances for its Material roles. Material names never
   retrieve coefficients from a database.
4. The browser or monorepo Node CLI freezes source, Catalog and Material context,
   builds every item, and stores exact artifact bytes in IndexedDB or on disk.
   Shared TypeScript compilation, evaluation, model validation and Measurement
   construction are independent of API transport and rendering.
5. The API accepts a manifest and 8 MiB chunks, checks length and SHA256, and
   persists finalized BuiltMeasurements without executing user code. One commit
   verifies source, Catalog, ownership and saved Measurement inputs, then creates
   all Measurement links and queues all Jobs atomically. No item runs before commit.
6. Persisted jobs are assigned to available launchers owned by the same user.
   A launcher starts one CAE worker at a time. Each worker connects directly to
   the server through a job-scoped WebSocket; binary chunks bypass launcher stdio.
7. `simulate.py` calls a catalog-selected Solver and records its tensors. A
   record is retained until its acknowledgement, and `sim.release()` ends the
   run-side ownership of the artifact.
8. The API stages each acknowledged record for the current execution attempt.
   After the worker confirms execution and resource cleanup, one transaction
   publishes RecordedData, Measurement completion, job success and the event.
   Partial and stale-attempt results are never published. Analysis
   and the 3D Viewer read the persisted tensors through their respective
   projections.

Batch definitions, prepared inputs, progress messages, terminal events and read
state survive a browser disconnect. The browser subscribes to server events and
restores snapshots using an event cursor; closing the Workbench only stops that
subscription. Completed selected Measurements are fetched again for visualization.
CalculationData postprocessing runs explicitly in the browser or CLI; Prediction iteration remains browser work. Both
do not automatically resume on reconnect. Failed runs require manual retry, which
reuses the saved source, Vars, model definitions, selections and parameters.
A newly generated Candidate reevaluates material.tsx for its new Vars; it does
not inherit the selected Measurement's parameter snapshot.

Local `experiment test` reads the same artifact and invokes the selected checkout's
CAE Python bridge. It uses existing program validation, CaeRun, Solver children,
RecordPacket acknowledgement and cleanup. It stores files before ACK and owns
foreground cancellation; it does not submit API jobs. `batch submit` only uploads
the artifact and never starts Python or resamples input. Local and remote results
share RecordedData meaning, while file/process and API/SSE lifecycles stay separate.

The account-level Batch Provider shares snapshots and in-flight page requests.
Progress events update local data directly; state events coalesce for 250 ms
before requesting a snapshot. Foreground runs await these shared updates instead
of polling. Reconnect failures back off at 5, 10 and 30 seconds; a healthy SSE
connection does not cause periodic detail requests.

GPStation owns `job_batches`, numbered `jobs`, execution-scoped `job_records`
staging and ordered `job_events`. CAE owns `cae_batches`, frozen Experiment inputs,
Measurement links and the conversion to RecordedData. The dispatcher rotates among
compatible batches using their last assignment time, then item order, with owner
and execution-mode capability checks and row locks. CAE owns temporary upload chunks.

Batch upload is `uploading`; its numbered Jobs remain `staged`. After commit Jobs
follow `queued -> assigned -> running -> finalizing -> succeeded/failed/cancelled`.
Interrupted execution fails; committed unstarted work and incomplete uploads survive
restart. Retry uses the same saved input and a new attempt number. Inactive uploads
expire after 24 hours; cancellation and expiry share the commit lock. Queued CAE
jobs do not expire. Legacy jobs without stored input require a new client build.

`/cae/batches` provides submission, listing, detail, cancellation, failed-item
retry and notification read state. `/cae/events` replays owner-scoped SSE events;
`/v1/jobs/{id}/stream` authenticates a worker for one Job, Launcher and attempt.
Event writers serialize commits before assigning event IDs, so a snapshot cursor
cannot miss a lower ID that commits later. The old Measurement record-upload
endpoint and CAE WebRTC RPCs are removed.

The browser may keep local draft source independently of an Experiment. Draft
Geometry becomes Experiment input only through an explicit handoff.

## Geometry and surface identity

The canonical Geometry scene preserves CSG roots, nodes, transforms, groups,
and source-surface provenance. Surface members authored as
`<geometry-id>/surface/<index>` become numeric selectors:

```json
{ "rootId": "optic", "sourceNodeId": "lens", "surfaceIndex": 1 }
```

`surfaceIndex` is the primitive's stable numeric slot; it is not derived from
triangle order. Transforms and Boolean evaluation carry the source node and slot
into the canonical scene. For example, a box uses local slots `0..5` for
`-X`, `+X`, `-Y`, `+Y`, `-Z`, and `+Z`. Solvers request a triangular mesh from
the shared Geometry service and map detector, emitter, boundary, and material
groups through these selectors.

Each Solver receives two local views: `experiment` for common Geometry and
`task` for task-local Geometry. Reference-length conversion changes only the
Solver view, never the stored Geometry or frozen Material snapshot.

## Solver and Catalog boundary

A task pins a Solver name and SemVer. The active Catalog descriptor supplies
its implementation locator, configuration parameters, methods, Material roles and model groups,
input ports, observations, and reference length unit. The resident kernel freezes
this descriptor in the RunPlan; only the invocation child imports the selected
implementation. There is no central per-Solver dispatch branch.

Solver-specific physics belongs under
`app/slaves/cae/app/solvers/<solver_package>/`, with one current `entry.py` per
Solver and no implementation version directories. The resident `app/kernel`
owns execution, resources, Catalog snapshots and transport. `kernel/api` owns
ABI 3 value and unit contracts, while `app/methods` owns shared geometry and
numerical operations. `app` itself contains only `__init__.py` and `__main__.py`.
There are no legacy Solver adapters or import facades. Catalog editing uses an
explicit Draft SQLite file, rewrites examples for the current versions, removes
previous identities, and publishes the completed file to the canonical Catalog.

## Non-sequential ray tracing

The ray-tracing Solver launches point, area, directional, or Lambertian sources
and follows the next physical collision rather than a prescribed surface
sequence. Detector surfaces produce ordinary outputs such as irradiance,
detected radiant flux, and source efficiency.

Physical shell thickness controls multilayer treatment. Adjacent shell layers
whose thickness is strictly less than `50 µm` form one coherent transfer-matrix
stack. A shell at exactly `50 µm` or thicker participates in ordinary geometric
collisions. This adaptive choice remains part of the physical tracing state,
including reflection, transmission, scattering, absorption, detector hits, and
ray branching.

All RecordedData declarations are `{ task, output }` references. The build freezes
Catalog output data schemas and semantic visualization contracts alongside Task,
output key, Solver version and Catalog revision. These contracts travel with the
Experiment, Measurement result envelope and offline export. Reading historical
results does not consult the current Catalog. Records without frozen contracts
remain stored but are unsupported by the new Viewer.

The Viewer selects renderers by semantic kind: mesh-field, polyline,
structured-field, tensor or bundle. Paths have no reserved root or special result
card. Contract member bindings connect vertices, offsets and optional attributes.
Calculation continues to address the existing dotted tensor leaves; result
contract metadata is not a tensor leaf. A shared scene supports one mesh field
and multiple polylines in the Experiment coordinate space. Deformed meshes cannot
be overlaid with undeformed paths.

## Execution, authentication, and ownership

`simulate.py` runs under the CAE AST allowlist and may call only `sim.run`,
`sim.record`, and `sim.release`. The allowlist protects the worker API boundary;
it is not an operating-system sandbox. Production workers therefore run under a
dedicated account or container.

- Browser sessions use cookies and CSRF protection; external clients use bearer
  tokens.
- The API enforces user ownership for Experiments, Measurements, jobs, and
  RecordedData.
- Launcher tokens authorize worker control, and one launcher owns one active job
  at a time.
- GPStation supports separate `webrtc` and `websocket` execution modes. Existing
  applications default to WebRTC; AI retains its browser Master connection and
  protocol. CAE declares WebSocket and has no WebRTC fallback.
- Monorepo Node build/evaluation children receive sanitized environments and bounded
  execution lifetimes. API credentials stay in the CLI parent. Local CAE Python
  invokes the existing runtime and does not receive API tokens.
- The `caemble` access-key scope permits owner authoring and execution APIs. Even
  an administrator-owned key acts as an ordinary user and cannot manage keys.
- The CAE worker preserves run and job identity, record acknowledgement,
  cancellation, and release lifecycle across its streamed messages.
- API launcher sockets are process-local, so a
  deployment keeps the API at one worker/replica unless that state is moved to a
  shared service.

## Implementation map

- `app/ui/src/lib/cad`: CAD execution, canonical Geometry, and render products.
- `app/ui/src/features/cae-workbench`: Measurement building and run UI.
- `app/api/app`: authentication, persistence, catalog routes, and orchestration.
- `app/catalog`: canonical Catalog and `catalogctl` Draft workflow.
- `app/ui/src/cli`: monorepo Node commands and local/remote execution adapters.
- `app/launcher`: per-user executable lifecycle and transport capability registration.
- `app/slaves/cae/app`: thin entry point, runtime `kernel`, shared `methods`, and current `solvers`.
- `app/sdk`: client and worker transport libraries.
