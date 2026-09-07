# Caemble architecture

Caemble is a local-first CAE Workbench. The browser authors and previews an
Experiment, the API owns persistence and orchestration, and a per-user launcher
runs isolated worker applications. The in-app `/docs` route is the user manual;
this document describes the implementation boundaries.

## Identities and payloads

Experiment and Solver SemVer are durable identities. An Experiment is addressed
by namespace, repository, tag, and SemVer; a Solver is addressed by name and
SemVer. Published identities are immutable, so a behavior or descriptor change
gets a new SemVer. The official Catalog contains one current version per Solver
name and current examples. Old user Experiments are not rewritten or redirected:
removed Solver versions fail lookup. Git preserves prior code and Catalog releases.

CAD source, Geometry scenes, Simulation programs, Material snapshots, Catalog
slices, and built Measurements are trusted, unversioned application payloads.
They move between repository-owned producers and consumers without a wrapper
format negotiation layer. The CAE worker applies unit and geometry
transformations needed by a Solver, while malformed values fail at their natural
runtime operation.

QuantityKind, Material, Solver, and Experiment catalog records live only in
`app/catalog/caemble_catalog/catalog.sqlite3`. Launcher `manifest.json` files
describe executables and are not Solver descriptors.

## Experiment data flow

1. The Workbench loads an immutable Experiment identity and evaluates its CAD
   source in the isolated browser runner.
2. Evaluation produces the common Geometry scene and any task-local Geometry.
   Preview meshes are render products, not solver input.
3. Material assignments are resolved into a frozen Material snapshot.
4. The UI registers a durable batch. Fixed Candidate and prepared Measurement
   runs retain their Vars and Material snapshots. Generated runs and Repeat Run
   let the API prepare new Candidates after registration.
5. The API freezes source, Catalog and visible Material inputs, then invokes a
   bounded Node child to compile, evaluate, resolve Materials and build canonical
   Measurements. Preparation uses the same source policy, compiler options,
   evaluation and Measurement builder as the browser without rendering meshes.
   Common Geometry and every task share one Material resolution before projection.
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
CalculationData postprocessing and Prediction iteration remain browser work and
do not automatically resume on reconnect. Failed runs require manual retry, which
reuses an existing prepared input without sampling it again.

Node preparation uses a `Popen` child managed in a background thread, including
input/output, cancellation and process reaping. This also supports the Windows
Selector event loop used by Uvicorn reload. Preparation errors retain their
exception type when no message is supplied and become durable failed items.

The account-level Batch Provider shares snapshots and in-flight page requests.
Progress events update local data directly; state events coalesce for 250 ms
before requesting a snapshot. Foreground runs await these shared updates instead
of polling. Reconnect failures back off at 5, 10 and 30 seconds; a healthy SSE
connection does not cause periodic detail requests.

GPStation owns `job_batches`, numbered `jobs`, execution-scoped `job_records`
staging and ordered `job_events`. CAE owns `cae_batches`, frozen Experiment inputs,
Measurement links and the conversion to RecordedData. Preparation rotates among
batches with at most one preparing or prepared waiting item per batch. Assignment
uses owner and execution-mode capability checks, FIFO order and row locks.

Server jobs follow `preparing → queued → assigned → running → finalizing →
succeeded/failed/cancelled`. Preparation and execution share one attempt number.
Restarted or disconnected execution fails; unstarted items continue. Cancelling a
batch also counts unmaterialized items and permanently stops their generation,
including when a failed materialized item is retried. Queued CAE jobs do not expire.

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
its implementation locator, parameters, methods, material roles and properties,
input ports, observations, and reference length unit. The resident kernel freezes
this descriptor in the RunPlan; only the invocation child imports the selected
implementation. There is no central per-Solver dispatch branch.

Solver-specific physics belongs under
`app/slaves/cae/app/solvers/<solver_package>/`, with one current `entry.py` per
Solver and no implementation version directories. The resident `app/kernel`
owns execution, resources, Catalog snapshots and transport. `kernel/api` owns
ABI 2 value and unit contracts, while `app/methods` owns shared geometry and
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

Visual paths use the semantic RecordedData group `rayPaths`, recorded in one
call as five aligned tensors:

| Member | Type and meaning |
| --- | --- |
| `vertices` | `float32[V, 3]` flattened vertex positions |
| `pathOffsets` | `uint32[P + 1]` vertex offsets, ending at `V` |
| `segmentPower` | `float32[S]` radiant flux aligned to segments |
| `pathWavelength` | `float32[P]` one wavelength per path |
| `segmentEvent` | `uint8[S]` event code aligned to segments |

The persisted names are `rayPaths.<member>`. The Viewer reconstructs paths from
the offsets; generic Analysis excludes these system tensors by requesting
RecordedData with `include_system: false`.

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
- Node preparation runs as a short-lived child with sanitized environment, a
  synchronous evaluation deadline and a parent process timeout. The artifact
  contains TypeScript and its declaration assets, and needs only Node.js 22.13 or
  later. Node permission mode allows reading only the artifact directory and
  denies filesystem writes and child processes. Source policy and VM timeout
  are not an operating-system sandbox.
- The CAE worker preserves run and job identity, record acknowledgement,
  cancellation, and release lifecycle across its streamed messages.
- API launcher sockets and resident-agent state are process-local, so a
  deployment keeps the API at one worker/replica unless that state is moved to a
  shared service.

## Implementation map

- `app/ui/src/lib/cad`: CAD execution, canonical Geometry, and render products.
- `app/ui/src/features/cae-workbench`: Measurement building and run UI.
- `app/api/app`: authentication, persistence, catalog routes, and orchestration.
- `app/catalog`: canonical Catalog and `catalogctl` Draft workflow.
- `app/ui/src/server`: canonical CAE input generation and standalone Node entry.
- `app/launcher`: per-user executable lifecycle and transport capability registration.
- `app/slaves/cae/app`: thin entry point, runtime `kernel`, shared `methods`, and current `solvers`.
- `app/sdk`: client and worker transport libraries.
