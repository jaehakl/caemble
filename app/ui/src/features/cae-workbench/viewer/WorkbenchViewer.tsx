import { useCallback, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
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
  const stale = experimentDocument.previewStale

  return (
    <div className="relative h-full min-h-0">
      <CadViewer
        activeExperimentTaskName={activeExperimentTaskName?.replace(/^tasks\//u, '').replace(/\.tsx$/u, '') ?? null}
        experiment={viewerDocument}
        onRenderEnd={handleRenderEnd}
        onRenderError={handleRenderError}
        onRenderStart={handleRenderStart}
      />
      {stale ? (
        <div className="pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50/95 px-2 py-1 text-xs text-amber-900 shadow-sm">
          <AlertTriangle className="size-3.5 shrink-0" />
          마지막 정상 Scene · 현재 source에 오류가 있습니다.
        </div>
      ) : null}
    </div>
  )
}
