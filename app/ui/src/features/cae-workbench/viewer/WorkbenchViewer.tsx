import { useMemo, useState } from 'react'
import { materialVarsHash } from '@/lib/material/resolution'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { RecordedResultContracts } from '@/contracts/results'
import { parseResultPolylines } from '@/features/viewer/viewer/resultPolylines'
import { ResultTensorView } from '@/features/viewer/viewer/ResultTensorView'
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
  resultContracts,
  resultErrors = {},
  resultSourceHash,
  resultVarsHash,
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
  resultErrors?: Readonly<Record<string, string>>
  resultContracts?: RecordedResultContracts | null
  resultSourceHash?: string | null
  resultVarsHash?: string | null
  selectionQuery: CadViewerSelectionQuery | null
  selectionSourceStatus: Readonly<Record<string, CadViewerSourceLookupStatus>>
  viewerExpanded: boolean
  recordedData?: RecordedData
  recordedRules?: readonly RecordedDataRule[]
  loading?: boolean
  downloadProgress?: Readonly<{ completed: number; total: number }> | null
}) {
  const mesh = useMemo(
    () => parseRecordedMeshFields(recordedRules, recordedData, resultContracts ?? {}),
    [recordedRules, recordedData, resultContracts],
  )
  const polylines = useMemo(
    () => parseResultPolylines(resultContracts ?? {}, recordedRules, recordedData),
    [resultContracts, recordedRules, recordedData],
  )
  const [overlay, setOverlay] = useState<readonly string[]>([])
  const [selectedView, setSelectedView] = useState('')
  const selectedField = mesh.fields.find((field) => field.label === selectedView)
  const selectedContract = resultContracts?.[selectedView]
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

  const frameMatches = Boolean(
    resultSourceHash &&
    resultVarsHash &&
    experimentDocument.evaluatedSnapshot?.sourceHash === resultSourceHash &&
    materialVarsHash(experimentDocument.evaluatedSnapshot.variables) === resultVarsHash,
  )
  const canOverlayGeometry =
    frameMatches && (!selectedContract || selectedContract.visualization.coordinateSpace === 'experiment')
  const sceneDocument = selectedView !== '' && !canOverlayGeometry ? null : viewerDocument
  const displayUnit = sceneDocument?.scene?.lengthUnit ?? selectedField?.lengthUnit ?? 'm'
  const selectedLines = polylines.bundles.filter(
    (bundle) =>
      bundle.id === selectedView ||
      (overlay.includes(bundle.id) &&
        frameMatches &&
        resultContracts?.[bundle.id].visualization.coordinateSpace === 'experiment' &&
        (!selectedContract || selectedContract.visualization.coordinateSpace === 'experiment')),
  )
  const renderScene = (
    meshRenderData?: Parameters<NonNullable<Parameters<typeof MeshFieldResult>[0]['renderViewer']>>[0],
    deformationScale = 0,
  ) => (
    <>
      {deformationScale > 0 && selectedLines.length ? (
        <p role="status" className="bg-amber-50 p-2 text-xs">
          변형 표시 중에는 원래 좌표의 polyline Overlay를 표시하지 않습니다.
        </p>
      ) : null}
      <CadViewer
        activeExperimentTaskName={activeExperimentTaskName ? experimentTaskName(activeExperimentTaskName) : null}
        experiment={sceneDocument}
        onFindSelectionSource={onFindSelectionSource}
        onRenderEnd={experimentDocument.handleRenderEnd}
        onRenderError={experimentDocument.handleRenderError}
        onRenderStart={experimentDocument.handleRenderStart}
        onSelectionQueryChange={onSelectionQueryChange}
        onSelectionSourcePathsChange={onSelectionSourcePathsChange}
        polylines={deformationScale > 0 ? [] : selectedLines}
        meshRenderData={meshRenderData}
        meshIdentity={selectedField?.identity}
        displayUnit={displayUnit}
        selectionQuery={selectionQuery}
        selectionSourceStatus={selectionSourceStatus}
        onToggleViewerExpanded={onToggleViewerExpanded}
        viewerExpanded={viewerExpanded}
      />
    </>
  )
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b bg-white p-2 text-xs">
        <select
          aria-label="Viewer 결과 선택"
          value={selectedView}
          onChange={(event) => setSelectedView(event.target.value)}
        >
          <option value="">Geometry</option>
          {Object.entries(resultContracts ?? {}).map(([name, result]) => (
            <option key={name} value={name}>
              {name} · {result.visualization.kind}
            </option>
          ))}
        </select>
        {Object.entries(resultContracts ?? {})
          .filter(([, result]) => result.visualization.kind === 'polyline')
          .map(([name, result]) => {
            const compatible =
              frameMatches &&
              result.visualization.coordinateSpace === 'experiment' &&
              (!selectedContract || selectedContract.visualization.coordinateSpace === 'experiment')
            return (
              <label
                key={name}
                title={compatible ? 'Geometry 좌표에 겹쳐 표시' : '선택 결과와 좌표계를 연결할 수 없습니다.'}
              >
                <input
                  type="checkbox"
                  aria-label={`${name} Overlay`}
                  disabled={!compatible || name === selectedView}
                  checked={name === selectedView || overlay.includes(name)}
                  onChange={(event) =>
                    setOverlay(event.target.checked ? [...overlay, name] : overlay.filter((item) => item !== name))
                  }
                />{' '}
                {name}
              </label>
            )
          })}
        {loading ? (
          <span role="status">
            저장 결과 불러오는 중{downloadProgress ? ` · ${downloadProgress.completed}/${downloadProgress.total}` : '…'}
          </span>
        ) : null}
        {!resultContracts && recordedRules.length ? (
          <span role="status">이전 결과 계약은 새 Viewer에서 지원하지 않습니다.</span>
        ) : null}
      </div>
      {!canOverlayGeometry && selectedView !== '' ? (
        <p role="status" className="p-2 text-xs">
          현재 Geometry와 저장 결과의 source 또는 Vars 좌표가 달라 Geometry Overlay를 표시하지 않습니다.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {selectedField ? (
          <MeshFieldResult
            key={selectedView}
            field={selectedField}
            displayUnit={displayUnit}
            renderViewer={(data, view) => renderScene(data, view.deformationScale)}
          />
        ) : selectedContract && !['mesh-field', 'polyline'].includes(selectedContract.visualization.kind) ? (
          <ResultTensorView
            key={selectedView}
            name={selectedView}
            contract={selectedContract}
            rules={recordedRules}
            data={recordedData}
          />
        ) : (
          renderScene()
        )}
      </div>
      {[
        ...Object.entries(resultErrors).map(([label, message]) => ({ label, message })),
        ...mesh.errors.filter((error) => !resultErrors[error.label]),
        ...polylines.errors.filter((error) => !resultErrors[error.label]),
      ].map((error) => (
        <p role="alert" key={error.label} className="bg-rose-50 p-2 text-xs text-red-700">
          {error.label}: {error.message}
        </p>
      ))}
    </div>
  )
}
