import { StructuredFieldResult } from '@/features/viewer/viewer/StructuredFieldResult'
import type { HeatmapRenderData } from '@/features/viewer/viewer/structuredField'
import { useEffect, useMemo, useRef, useState } from 'react'
import { materialVarsHash } from '@/lib/material/resolution'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { MeasurementVisualizations, RecordedResultContracts } from '@/contracts/results'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { parseResultPolylines } from '@/features/viewer/viewer/resultPolylines'
import { ResultTensorView } from '@/features/viewer/viewer/ResultTensorView'
import { experimentTaskName, type ExperimentSourceDocument } from '@/lib/cad/source'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
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
  resultContracts: outputContracts,
  resultErrors: outputErrors = {},
  visualizations = {},
  resultSourceHash,
  resultVarsHash,
  selectionQuery,
  selectionSourceStatus,
  viewerExpanded,
  recordedData: outputData,
  recordedRules: outputRules = [],
  loading = false,
  downloadProgress,
  autoSelectResult = false,
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
  visualizations?: MeasurementVisualizations
  resultSourceHash?: string | null
  resultVarsHash?: string | null
  selectionQuery: CadViewerSelectionQuery | null
  selectionSourceStatus: Readonly<Record<string, CadViewerSourceLookupStatus>>
  viewerExpanded: boolean
  recordedData?: RecordedData
  recordedRules?: readonly RecordedDataRule[]
  loading?: boolean
  downloadProgress?: Readonly<{ completed: number; total: number }> | null
  autoSelectResult?: boolean
}) {
  const visual = useMemo(() => visualizationData(visualizations), [visualizations])
  const resultContracts = useMemo(
    () =>
      outputContracts || Object.keys(visual.contracts).length ? { ...outputContracts, ...visual.contracts } : null,
    [outputContracts, visual],
  )
  const recordedRules = useMemo(() => [...outputRules, ...visual.rules], [outputRules, visual])
  const recordedData = useMemo(
    () => (outputData || Object.keys(visual.data).length ? { ...outputData, ...visual.data } : undefined),
    [outputData, visual],
  )
  const resultErrors = useMemo(() => ({ ...outputErrors, ...visual.errors }), [outputErrors, visual])
  const resultProvenance = useMemo(
    () => ({
      ...Object.fromEntries(
        Object.entries(outputData ?? {}).map(([name, tensor]) => [
          name,
          isDataTensor(tensor) ? tensor.provenance : undefined,
        ]),
      ),
      ...visual.provenance,
    }),
    [outputData, visual],
  )
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
  const selectionMade = useRef(false)
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
  useEffect(() => {
    if (!autoSelectResult || !recordedData || selectionMade.current) return
    const candidates = Object.entries(resultContracts ?? {}).filter(([name, result]) => {
      if (resultErrors[name]) return false
      if (result.visualization.kind === 'mesh-field') return mesh.fields.some((field) => field.label === name)
      if (result.visualization.kind === 'polyline') return polylines.bundles.some((bundle) => bundle.id === name)
      return Object.keys(recordedData).some((path) => path === name || path.startsWith(`${name}.`))
    })
    const spatial = candidates.filter(
      ([, result]) =>
        frameMatches &&
        result.visualization.coordinateSpace === 'experiment' &&
        (result.visualization.kind === 'mesh-field' ||
          result.visualization.kind === 'polyline' ||
          result.visualization.kind === 'box-grid' ||
          (result.visualization.kind === 'structured-field' && result.visualization.grid)),
    )
    setSelectedView(
      (spatial.length ? spatial[Math.floor(Math.random() * spatial.length)] : candidates[candidates.length - 1])?.[0] ??
        '',
    )
    selectionMade.current = candidates.length > 0
  }, [autoSelectResult, recordedData, resultContracts, resultErrors, mesh, polylines, frameMatches])
  const canOverlayGeometry =
    frameMatches && (!selectedContract || selectedContract.visualization.coordinateSpace === 'experiment')
  const sceneDocument = selectedView !== '' && !canOverlayGeometry ? null : viewerDocument
  const gridAxis =
    selectedContract?.visualization.kind === 'box-grid' ? 0 : selectedContract?.visualization.grid?.xyzAxes[0]
  const gridUnit =
    gridAxis === undefined
      ? undefined
      : recordedRules.find((rule) => rule.label === selectedView)?.result.axes?.[gridAxis]?.unit
  const displayUnit = sceneDocument?.scene?.lengthUnit ?? selectedField?.lengthUnit ?? gridUnit ?? 'm'
  function sameResultInvocation(name: string) {
    if (!selectedView || selectedView === name) return true
    const selected = resultProvenance[selectedView]
    const other = resultProvenance[name]
    return Boolean(
      selected &&
      other &&
      selected.task === other.task &&
      selected.solver.name === other.solver.name &&
      selected.solver.version === other.solver.version &&
      selected.stateRevision === other.stateRevision &&
      selected.invocation === other.invocation &&
      selected.catalogRevision === other.catalogRevision,
    )
  }
  const selectedLines = polylines.bundles.filter(
    (bundle) =>
      bundle.id === selectedView ||
      (overlay.includes(bundle.id) &&
        sameResultInvocation(bundle.id) &&
        frameMatches &&
        resultContracts?.[bundle.id].visualization.coordinateSpace === 'experiment' &&
        (!selectedContract || selectedContract.visualization.coordinateSpace === 'experiment')),
  )
  const renderScene = (
    meshRenderData?: Parameters<NonNullable<Parameters<typeof MeshFieldResult>[0]['renderViewer']>>[0],
    deformationScale = 0,
    heatmapRenderData?: HeatmapRenderData,
  ) => (
    <>
      {deformationScale > 0 && selectedLines.length ? (
        <p role="status" className="bg-amber-50 p-2 text-xs">
          변형 표시 중에는 원래 좌표의 polyline Overlay를 표시하지 않습니다.
        </p>
      ) : null}
      <CadViewer
        activeExperimentTaskName={activeExperimentTaskName ? experimentTaskName(activeExperimentTaskName) : null}
        experiment={deformationScale > 0 ? null : sceneDocument}
        onFindSelectionSource={onFindSelectionSource}
        onRenderEnd={experimentDocument.handleRenderEnd}
        onRenderError={experimentDocument.handleRenderError}
        onRenderStart={experimentDocument.handleRenderStart}
        onSelectionQueryChange={onSelectionQueryChange}
        onSelectionSourcePathsChange={onSelectionSourcePathsChange}
        polylines={deformationScale > 0 ? [] : selectedLines}
        meshRenderData={meshRenderData}
        heatmapRenderData={heatmapRenderData}
        meshIdentity={selectedField?.identity}
        displayUnit={displayUnit}
        preserveCameraOnUpdate={autoSelectResult}
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
          onChange={(event) => {
            selectionMade.current = true
            setSelectedView(event.target.value)
          }}
        >
          <option value="">Geometry</option>
          {selectedView && !selectedContract ? <option value={selectedView}>{selectedView} · 결과 없음</option> : null}
          {Object.keys(resultContracts ?? {}).map((name) => (
            <option key={name} value={name}>
              {name.startsWith('@visualizations.')
                ? `${name.slice('@visualizations.'.length)} · 시각화`
                : `${name} · Output`}
            </option>
          ))}
        </select>
        {Object.entries(resultContracts ?? {})
          .filter(([, result]) => result.visualization.kind === 'polyline')
          .map(([name, result]) => {
            const compatible =
              sameResultInvocation(name) &&
              polylines.bundles.some((bundle) => bundle.id === name) &&
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
                {overlay.includes(name) && !compatible ? ' · Overlay를 표시할 수 없습니다.' : ''}
              </label>
            )
          })}
        {overlay
          .filter((name) => !resultContracts?.[name])
          .map((name) => (
            <label key={name} title="새 실행에 결과가 없어 표시할 수 없습니다.">
              <input
                type="checkbox"
                checked
                aria-label={`${name} Overlay`}
                onChange={() => setOverlay(overlay.filter((item) => item !== name))}
              />
              {name} · 결과 없음
            </label>
          ))}
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
        {selectedView && !selectedContract ? (
          <p role="alert" className="p-3 text-red-700">
            {selectedView}: 새 실행에 선택한 결과가 없습니다.
          </p>
        ) : resultErrors[selectedView] ? (
          <p role="alert" className="p-3 text-red-700">
            {selectedView}: {resultErrors[selectedView]}
          </p>
        ) : selectedField ? (
          <MeshFieldResult
            key={selectedView}
            field={selectedField}
            displacementFields={mesh.fields}
            displayUnit={displayUnit}
            renderViewer={(data, view) => renderScene(data, view.deformationScale)}
          />
        ) : selectedContract?.visualization.kind === 'box-grid' ||
          (selectedContract?.visualization.kind === 'structured-field' && selectedContract.visualization.grid) ? (
          <StructuredFieldResult
            key={selectedView}
            name={selectedView}
            contract={selectedContract}
            rules={recordedRules}
            data={recordedData}
            displayUnit={displayUnit}
            renderViewer={(data) => renderScene(undefined, 0, data)}
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
      ]
        .filter((error) => error.label !== selectedView || !resultErrors[selectedView])
        .map((error) => (
          <p role="alert" key={error.label} className="bg-rose-50 p-2 text-xs text-red-700">
            {error.label}: {error.message}
          </p>
        ))}
    </div>
  )
}
