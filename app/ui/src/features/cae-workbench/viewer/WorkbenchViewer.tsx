import { useMemo } from 'react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { RayPathBundle } from '@/lib/cad/model'
import { experimentTaskName, type ExperimentSourceDocument } from '@/lib/cad/source'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'

export function WorkbenchViewer({
  activeExperimentTaskName,
  experiment,
  experimentDocument,
  onFindSelectionSource,
  onSelectionQueryChange,
  onSelectionSourcePathsChange,
  onToggleViewerExpanded,
  rayPaths,
  selectionQuery,
  selectionSourceStatus,
  viewerExpanded,
}: {
  activeExperimentTaskName?: string | null
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
  onFindSelectionSource: (value: string) => void
  onSelectionQueryChange: (query: CadViewerSelectionQuery | null) => void
  onSelectionSourcePathsChange: (values: readonly string[]) => void
  onToggleViewerExpanded: () => void
  rayPaths?: readonly RayPathBundle[]
  selectionQuery: CadViewerSelectionQuery | null
  selectionSourceStatus: Readonly<Record<string, CadViewerSourceLookupStatus>>
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
        activeExperimentTaskName={activeExperimentTaskName ? experimentTaskName(activeExperimentTaskName) : null}
        experiment={viewerDocument}
        onFindSelectionSource={onFindSelectionSource}
        onRenderEnd={experimentDocument.handleRenderEnd}
        onRenderError={experimentDocument.handleRenderError}
        onRenderStart={experimentDocument.handleRenderStart}
        onSelectionQueryChange={onSelectionQueryChange}
        onSelectionSourcePathsChange={onSelectionSourcePathsChange}
        rayPaths={rayPaths}
        selectionQuery={selectionQuery}
        selectionSourceStatus={selectionSourceStatus}
        onToggleViewerExpanded={onToggleViewerExpanded}
        viewerExpanded={viewerExpanded}
      />
    </div>
  )
}
