import { useCallback, useMemo } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { CadScene, ExperimentSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { WorkbenchTabId } from '../types'

export function WorkbenchViewer({
  activeExperimentTaskName,
  activeTab,
  experiment,
  experimentDocument,
  geometryPreview,
}: {
  activeExperimentTaskName?: string | null
  activeTab: WorkbenchTabId
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
  geometryPreview: Readonly<{
    busy: boolean
    error: string | null
    scene: CadScene | null
    sceneHash: string | null
    stale: boolean
  }>
}) {
  const viewerDocument = useMemo(
    () =>
      activeTab === 'geometry'
        ? geometryPreview.scene
          ? {
              scene: geometryPreview.scene,
              sceneHash: geometryPreview.sceneHash,
              taskScenes: Object.freeze({}),
              taskSceneHashes: Object.freeze({}),
              variables: Object.freeze({}),
            }
          : null
        : experiment
          ? {
              scene: experimentDocument.scene,
              sceneHash: experimentDocument.sceneHash,
              taskScenes: experimentDocument.taskScenes,
              taskSceneHashes: experimentDocument.taskSceneHashes,
              variables: experimentDocument.variables,
            }
          : null,
    [
      activeTab,
      experiment,
      experimentDocument.scene,
      experimentDocument.sceneHash,
      experimentDocument.taskSceneHashes,
      experimentDocument.taskScenes,
      experimentDocument.variables,
      geometryPreview.scene,
      geometryPreview.sceneHash,
    ],
  )
  const handleRenderStart = useCallback(() => experimentDocument.handleRenderStart(), [experimentDocument])
  const handleRenderEnd = useCallback(() => experimentDocument.handleRenderEnd(), [experimentDocument])
  const handleRenderError = useCallback(
    (message: string) => experimentDocument.handleRenderError(message),
    [experimentDocument],
  )
  const ignoreRenderStart = useCallback(() => undefined, [])
  const ignoreRenderEnd = useCallback(() => undefined, [])
  const ignoreRenderError = useCallback(() => undefined, [])

  const stale = activeTab === 'geometry' ? geometryPreview.stale : experimentDocument.previewStale

  return (
    <div className="relative h-full min-h-0">
      <CadViewer
        activeExperimentTaskName={
          activeTab === 'geometry'
            ? null
            : (activeExperimentTaskName?.replace(/^tasks\//u, '').replace(/\.tsx$/u, '') ?? null)
        }
        experiment={viewerDocument}
        onRenderEnd={activeTab === 'geometry' ? ignoreRenderEnd : handleRenderEnd}
        onRenderError={activeTab === 'geometry' ? ignoreRenderError : handleRenderError}
        onRenderStart={activeTab === 'geometry' ? ignoreRenderStart : handleRenderStart}
      />
      {stale ? (
        <div className="pointer-events-none absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50/95 px-2 py-1 text-xs text-amber-900 shadow-sm">
          <AlertTriangle className="size-3.5 shrink-0" />
          마지막 정상 Scene · 현재 source에 오류가 있습니다.
        </div>
      ) : activeTab === 'geometry' && geometryPreview.busy ? (
        <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm">
          <LoaderCircle className="size-3.5 animate-spin" /> Geometry preview 평가 중
        </div>
      ) : null}
    </div>
  )
}
