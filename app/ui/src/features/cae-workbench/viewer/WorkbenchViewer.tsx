import { useMemo, useState } from 'react'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { RayPathBundle } from '@/lib/cad/model'
import { experimentTaskName, type ExperimentSourceDocument } from '@/lib/cad/source'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { parseRecordedMeshFields } from '@/features/viewer/viewer/meshFields'
import { MeshFieldResult } from '@/features/viewer/viewer/MeshFieldResult'

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
  recordedData,
  recordedRules = [],
  loading = false,
  downloadProgress,
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
  recordedData?: RecordedData
  recordedRules?: readonly RecordedDataRule[]
  loading?: boolean
  downloadProgress?: Readonly<{ completed: number; total: number }> | null
}) {
  const mesh = useMemo(() => parseRecordedMeshFields(recordedRules, recordedData), [recordedRules, recordedData])
  const [selectedView, setSelectedView] = useState('mesh')
  const selectedField = mesh.fields.find((field) => field.label === selectedView) ?? mesh.fields[0]
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
      {loading ? (
        <div role="status" className="absolute top-2 left-2 z-20 rounded bg-white p-2 text-xs shadow">
          저장 결과 불러오는 중{downloadProgress ? ` · ${downloadProgress.completed}/${downloadProgress.total}` : '…'}
        </div>
      ) : null}
      {mesh.labels.length > 0 ? (
        <div className="absolute top-2 right-2 z-20 rounded bg-white p-1 shadow">
          <select
            aria-label="Viewer 결과 선택"
            value={selectedView === 'geometry' ? 'geometry' : (selectedField?.label ?? 'mesh')}
            onChange={(event) => setSelectedView(event.target.value)}
          >
            <option value="geometry">Geometry</option>
            {mesh.fields.map((field) => (
              <option key={field.label} value={field.label}>
                {field.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selectedView !== 'geometry' && selectedField ? (
        <div className="h-full overflow-auto pt-8" aria-busy={loading}>
          <MeshFieldResult key={`${selectedField.identity}:${selectedField.label}`} field={selectedField} />
        </div>
      ) : (
        <>
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
        </>
      )}
      {mesh.errors.map((error) => (
        <div role="alert" key={error.label} className="absolute bottom-2 left-2 bg-white p-2 text-red-700">
          {error.label}: {error.message}
        </div>
      ))}
    </div>
  )
}
