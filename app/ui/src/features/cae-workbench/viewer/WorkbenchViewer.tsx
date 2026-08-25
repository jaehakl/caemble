import { useMemo } from 'react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { ExperimentSourceDocument, RayPathBundle } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'

export function WorkbenchViewer({
  activeExperimentTaskName,
  experiment,
  experimentDocument,
  onToggleViewerExpanded,
  rayPaths,
  viewerExpanded,
}: {
  activeExperimentTaskName?: string | null
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
  onToggleViewerExpanded: () => void
  rayPaths?: readonly RayPathBundle[]
  viewerExpanded: boolean
}) {
  const viewerDocument = useMemo(
    () =>
      experiment
        ? {
            scene: experimentDocument.scene,
            sceneHash: experimentDocument.sceneHash,
            taskScenes: experimentDocument.taskScenes,
            taskSceneHashes: experimentDocument.taskSceneHashes,
          }
        : null,
    [
      experiment,
      experimentDocument.scene,
      experimentDocument.sceneHash,
      experimentDocument.taskSceneHashes,
      experimentDocument.taskScenes,
    ],
  )

  return (
    <div className="relative h-full min-h-0">
      <CadViewer
        activeExperimentTaskName={activeExperimentTaskName?.replace(/^tasks\//u, '').replace(/\.tsx$/u, '') ?? null}
        experiment={viewerDocument}
        onRenderEnd={experimentDocument.handleRenderEnd}
        onRenderError={experimentDocument.handleRenderError}
        onRenderStart={experimentDocument.handleRenderStart}
        rayPaths={rayPaths}
        onToggleViewerExpanded={onToggleViewerExpanded}
        viewerExpanded={viewerExpanded}
      />
    </div>
  )
}
