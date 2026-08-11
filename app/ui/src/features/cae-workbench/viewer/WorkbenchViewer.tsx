import { useCallback, useMemo } from 'react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { CadDocumentType, CadSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'

export function WorkbenchViewer({
  activeExperimentTaskName,
  experiment,
  experimentDocument,
  structure,
  structureDocument,
}: {
  activeExperimentTaskName?: string | null
  experiment: CadSourceDocument | null
  experimentDocument: CadDocumentController
  structure: CadSourceDocument | null
  structureDocument: CadDocumentController
}) {
  const structureViewerDocument = useMemo(
    () =>
      structure
        ? {
            scene: structureDocument.scene,
            sceneHash: structureDocument.sceneHash,
            variables: structureDocument.variables,
          }
        : null,
    [structure, structureDocument.scene, structureDocument.sceneHash, structureDocument.variables],
  )
  const experimentViewerDocument = useMemo(
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
  const handleRenderStart = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderStart()
      if (sources.includes('experiment')) experimentDocument.handleRenderStart()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderEnd = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderEnd()
      if (sources.includes('experiment')) experimentDocument.handleRenderEnd()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderError = useCallback(
    (message: string, sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderError(message)
      if (sources.includes('experiment')) experimentDocument.handleRenderError(message)
    },
    [experimentDocument, structureDocument],
  )

  return (
    <CadViewer
      activeExperimentTaskName={activeExperimentTaskName?.replace(/^tasks\//u, '').replace(/\.tsx$/u, '') ?? null}
      experiment={experimentViewerDocument}
      structure={structureViewerDocument}
      onRenderEnd={handleRenderEnd}
      onRenderError={handleRenderError}
      onRenderStart={handleRenderStart}
    />
  )
}
