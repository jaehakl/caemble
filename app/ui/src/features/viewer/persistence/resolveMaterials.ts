import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import { deserializeCadScene } from '@/lib/cad/execution/mesh'
import type { EvaluatedExperimentSnapshot } from '@/lib/cad/execution/snapshotTypes'
import { resolveSceneMaterials } from '@/lib/material/document'

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
