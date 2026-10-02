import type { CatalogRuntimeSlice } from '@caemble/execution/contracts/catalog'
import type { MeasurementMaterialSnapshot } from '@caemble/execution/contracts/api/measurement'
import { deserializeCadScene } from '@caemble/execution/cad/execution/mesh'
import type { EvaluatedExperimentSnapshot } from '@caemble/execution/cad/execution/snapshotTypes'
import { resolveSceneMaterials } from '@caemble/execution/material/document'

export function resolveDocumentMaterials(
  snapshot: EvaluatedExperimentSnapshot,
  stored: MeasurementMaterialSnapshot | null,
  catalog: CatalogRuntimeSlice,
) {
  return resolveSceneMaterials(
    {
      ...snapshot,
      scene: deserializeCadScene(snapshot.renderScene),
      taskScenes: Object.fromEntries(
        Object.entries(snapshot.taskRenderScenes).map(([name, scene]) => [name, deserializeCadScene(scene)]),
      ),
    },
    stored,
    catalog,
  )
}
