import { useCallback, useMemo } from 'react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { ExperimentSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'

export function WorkbenchViewer({
  activeExperimentTaskName,
  experiment,
  experimentDocument,
}: {
  activeExperimentTaskName?: string | null
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
}) {
  const viewerDocument = useMemo(
    () =>
      experiment
        ? {
            scene: experimentDocument.scene,
            sceneHash: experimentDocument.sceneHash,
            taskScenes: experimentDocument.taskScenes,
            taskSceneHashes: experimentDocument.taskSceneHashes,
            variables: experimentDocument.variables,
          }
        : null,
    [
      experiment,
      experimentDocument.scene,
      experimentDocument.sceneHash,
      experimentDocument.taskSceneHashes,
      experimentDocument.taskScenes,
      experimentDocument.variables,
    ],
  )
  const handleRenderStart = useCallback(() => experimentDocument.handleRenderStart(), [experimentDocument])
  const handleRenderEnd = useCallback(() => experimentDocument.handleRenderEnd(), [experimentDocument])
  const handleRenderError = useCallback(
    (message: string) => experimentDocument.handleRenderError(message),
    [experimentDocument],
  )

  return (
    <CadViewer
      activeExperimentTaskName={activeExperimentTaskName?.replace(/^tasks\//u, '').replace(/\.tsx$/u, '') ?? null}
      experiment={viewerDocument}
      onRenderEnd={handleRenderEnd}
      onRenderError={handleRenderError}
      onRenderStart={handleRenderStart}
    />
  )
}
