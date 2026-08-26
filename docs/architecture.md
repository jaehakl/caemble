# Caemble architecture

Caemble is a local-first CAE Workbench. The browser authors and previews an
Experiment, the API owns persistence and orchestration, and a per-user launcher
runs isolated worker applications. The in-app `/docs` route is the user manual;
this document describes the implementation boundaries.

## Identities and payloads

Experiment and Solver SemVer are durable identities. An Experiment is addressed
by namespace, repository, tag, and SemVer; a Solver is addressed by name and
SemVer. Published identities are immutable, so a behavior or descriptor change
gets a new SemVer.

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
4. The UI builds a Measurement containing the trusted Geometry, Simulation,
   Material, and Catalog payloads for that run.
5. Job control and attachments travel directly between browser and worker over
   WebRTC; the API retains orchestration state rather than solver payloads.
6. `simulate.py` calls a catalog-selected Solver and records its tensors. A
   record is retained until its acknowledgement, and `sim.release()` ends the
   run-side ownership of the artifact.
7. The API persists RecordedData for the owning user and Measurement. Analysis
   and the 3D Viewer read the persisted tensors through their respective
   projections.

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
input ports, observations, and reference length unit. The CAE registry imports
the implementation lazily; there is no central per-Solver dispatch branch.

Solver-specific physics belongs under
`app/slaves/cae/app/solvers/<solver_package>/`. Shared geometry, units, tensor,
and numerical services remain in the solver framework. Catalog editing uses an
explicit Draft SQLite file and publishes that file to the canonical Catalog.

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
- `app/launcher`: per-user executable lifecycle and WebRTC signaling.
- `app/slaves/cae/app`: AST program runtime, Solver framework, and physics.
- `app/sdk`: client and worker transport libraries.
