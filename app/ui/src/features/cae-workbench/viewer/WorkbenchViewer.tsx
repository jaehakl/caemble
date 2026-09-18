import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'
import { cameraPoseSchema, durableViewerSettings, type ViewerDefaults } from '@/contracts/viewerDefaults'
import { ViewerPresentationMenu, type ViewerPresentationActions } from '@/features/experiment/ViewerPresentationMenu'
import {
  createComparisonSettings,
  ViewerPersistenceContext,
  type ViewerPersistence,
  ViewerComparisonContext,
  useViewerComparison,
  useViewerSetting,
  ViewerControls,
  type ViewerComparison,
} from '@/features/viewer/viewer/comparisonSettings'
import { BoxGridResult } from '@/features/viewer/viewer/BoxGridResult'
import { calculationExperimentRecordReference } from '@/lib/calculation/dependencies'
import type { HeatmapRenderData } from '@/features/viewer/viewer/structuredField'
import { useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
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
import { parseRecordedMeshFields, type MeshRenderData } from '@/features/viewer/viewer/meshFields'
import { MeshFieldResult } from '@/features/viewer/viewer/MeshFieldResult'
import { parseRecordedMeshTransforms } from '@/features/viewer/viewer/meshTransforms'
import { MeshTransformResult } from '@/features/viewer/viewer/MeshTransformResult'
import { parseRecordedParticleSets } from '@/features/viewer/viewer/particleSets'
import { ParticleSetResult } from '@/features/viewer/viewer/ParticleSetResult'

// Box Grid carries its experiment placement in the recorded Box metadata.
function usesExperimentCoordinates(visualization: NonNullable<RecordedResultContracts[string]>['visualization']) {
  return visualization.kind === 'box-grid' || visualization.coordinateSpace === 'experiment'
}

export type WorkbenchViewerProps = {
  initialDefaults?: ViewerDefaults | null
  presentation?: ViewerPresentationActions
  calculationSource?: string
  activeExperimentTaskName?: string | null
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
  onFindSelectionSource: (value: string) => void
  onSelectionQueryChange: (query: CadViewerSelectionQuery | null) => void
  onSelectionSourcePathsChange: (values: readonly string[]) => void
  onToggleViewerExpanded?: () => void
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
  captureRef?: Ref<HTMLDivElement>
  selectedResult?: string
  onSelectedResultChange?: (name: string) => void
  comparison?: ViewerComparison
  showToolbar?: boolean
  /** Retain camera, result selection and controls across pending Prediction renders. */
  persistenceKey?: string
  resultPlaceholder?: string
}

export function WorkbenchViewer(props: WorkbenchViewerProps) {
  const sessions = useRef(new Map<string, ViewerPersistence>())
  const sessionKey = props.persistenceKey ?? 'default'
  if (!sessions.current.has(sessionKey)) {
    sessions.current.set(sessionKey, {
      settings: createComparisonSettings(props.initialDefaults?.settings),
      camera: createComparisonCamera(props.initialDefaults?.camera),
      item: '',
    })
  }
  const persistent = sessions.current.get(sessionKey)
  const previous = useRef<WorkbenchViewerProps | null>(null)
  const name = props.selectedResult ?? ''
  const visualName = name.startsWith('@visualizations.')
  const present =
    !name ||
    Boolean(
      visualName
        ? Object.keys(visualizationData(props.visualizations ?? {}).data).some(
            (key) => key === name || key.startsWith(`${name}.`),
          )
        : Object.keys(props.recordedData ?? {}).some((key) => key === name || key.startsWith(`${name}.`)),
    )
  if (present && !props.loading && !props.resultErrors?.[name]) previous.current = props
  const retained =
    props.comparison && (!present || props.resultErrors?.[name]) && previous.current?.selectedResult === name
      ? previous.current
      : null
  const unavailable = Boolean(
    !props.resultPlaceholder && props.comparison && name && (!present || props.resultErrors?.[name]),
  )
  return (
    <ViewerPersistenceContext.Provider value={persistent ?? null}>
      <ViewerComparisonContext.Provider value={props.comparison ?? null}>
        <div className="relative h-full min-h-0">
          <div className={`h-full min-h-0 ${unavailable ? 'invisible' : ''}`}>
            <ViewerContent
              {...props}
              recordedData={retained?.recordedData ?? props.recordedData}
              recordedRules={retained?.recordedRules ?? props.recordedRules}
              resultContracts={retained?.resultContracts ?? props.resultContracts}
              visualizations={retained?.visualizations ?? props.visualizations}
              resultErrors={unavailable && retained ? retained.resultErrors : props.resultErrors}
            />
          </div>
          {unavailable ? (
            <p role="status" className="absolute inset-0 grid place-items-center p-3 text-sm">
              {props.resultErrors?.[name] ??
                (props.loading ? '데이터 갱신 중… 설정을 유지합니다.' : '선택한 데이터가 없습니다. 설정은 유지됩니다.')}
            </p>
          ) : null}
        </div>
      </ViewerComparisonContext.Provider>
    </ViewerPersistenceContext.Provider>
  )
}

function ViewerContent({
  initialDefaults,
  presentation,
  calculationSource,
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
  captureRef,
  selectedResult,
  onSelectedResultChange,
  showToolbar = true,
  persistenceKey,
  resultPlaceholder,
}: WorkbenchViewerProps) {
  const localCaptureRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(captureRef, () => localCaptureRef.current!)
  const initialSelection = useRef(initialDefaults?.selectedResult)
  const comparison = useViewerComparison()
  const persistent = useContext(ViewerPersistenceContext)
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
  const transforms = useMemo(
    () => parseRecordedMeshTransforms(recordedRules, recordedData, resultContracts ?? {}),
    [recordedRules, recordedData, resultContracts],
  )
  const particles = useMemo(
    () => parseRecordedParticleSets(recordedRules, recordedData, resultContracts ?? {}),
    [recordedRules, recordedData, resultContracts],
  )
  const [selections, setSelections] = useState<Record<string, string>>({})
  const scope = persistenceKey ?? ''
  const selectedView = selectedResult ?? selections[scope] ?? ''
  const [overlay, setOverlay] = useViewerSetting<readonly string[]>('overlay', [], 'item', undefined, selectedView)
  const selectionMade = useRef(new Set<string>())
  const selectedField = mesh.fields.find((field) => field.label === selectedView)
  const selectedMotion = transforms.motions.find((motion) => motion.label === selectedView)
  const selectedParticles = particles.particles.find((value) => value.label === selectedView)
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

  const snapshot = experimentDocument.evaluatedSnapshot
  const frameBlockedReason =
    !snapshot || !experimentDocument.scene
      ? 'Geometry가 준비되지 않았습니다. 평가가 끝난 뒤 Geometry 겹치기를 사용할 수 있습니다.'
      : !resultSourceHash || !resultVarsHash
        ? '결과의 source/Vars 비교 정보가 없어 Geometry 겹치기를 사용할 수 없습니다.'
        : snapshot.sourceHash !== resultSourceHash
          ? 'Geometry와 결과의 source가 달라 Geometry 겹치기를 사용할 수 없습니다.'
          : materialVarsHash(snapshot.variables) !== resultVarsHash
            ? 'Geometry와 결과의 Vars가 달라 Geometry 겹치기를 사용할 수 없습니다.'
            : undefined
  const frameMatches = !frameBlockedReason
  useEffect(() => {
    if (
      selectedResult !== undefined ||
      !autoSelectResult ||
      loading ||
      !recordedData ||
      selectionMade.current.has(scope) ||
      resultPlaceholder
    )
      return
    const candidates = Object.entries(resultContracts ?? {}).filter(([name, result]) => {
      if (resultErrors[name]) return false
      if (result.visualization.kind === 'mesh-field') return mesh.fields.some((field) => field.label === name)
      if (result.visualization.kind === 'mesh-transform')
        return transforms.motions.some((motion) => motion.label === name)
      if (result.visualization.kind === 'particle-set') return particles.particles.some((value) => value.label === name)
      if (result.visualization.kind === 'polyline') return polylines.bundles.some((bundle) => bundle.id === name)
      return Object.keys(recordedData).some((path) => path === name || path.startsWith(`${name}.`))
    })
    const spatial = candidates.filter(
      ([, result]) =>
        frameMatches &&
        usesExperimentCoordinates(result.visualization) &&
        (result.visualization.kind === 'mesh-field' ||
          result.visualization.kind === 'mesh-transform' ||
          result.visualization.kind === 'particle-set' ||
          result.visualization.kind === 'polyline' ||
          result.visualization.kind === 'box-grid' ||
          (result.visualization.kind === 'structured-field' && result.visualization.grid)),
    )
    let largestBoxGrid: string | undefined
    let largestGridCount = 0
    for (const [name, result] of candidates) {
      if (result.visualization.kind !== 'box-grid') continue
      const tensor = recordedData[name]
      if (!isDataTensor(tensor) || !Array.isArray(tensor.shape)) continue
      const gridShape = tensor.boxGrid?.gridShape
      if (
        !Array.isArray(gridShape) ||
        gridShape.length !== 3 ||
        gridShape.some((length, axis) => !Number.isSafeInteger(length) || length <= 0 || length !== tensor.shape[axis])
      )
        continue
      const count = gridShape.reduce((total, length) => total * length, 1)
      if (Number.isSafeInteger(count) && count > largestGridCount) {
        largestBoxGrid = name
        largestGridCount = count
      }
    }
    const preferred = initialSelection.current
    const nextSelection =
      (preferred === '' || candidates.some(([name]) => name === preferred) ? preferred : undefined) ??
      largestBoxGrid ??
      (spatial.length ? spatial[Math.floor(Math.random() * spatial.length)] : candidates[candidates.length - 1])?.[0] ??
      ''
    setSelections((current) => ({ ...current, [scope]: nextSelection }))
    if (candidates.length > 0 || preferred === '') selectionMade.current.add(scope)
  }, [
    selectedResult,
    scope,
    resultPlaceholder,
    autoSelectResult,
    loading,
    recordedData,
    resultContracts,
    resultErrors,
    mesh,
    transforms,
    particles,
    polylines,
    frameMatches,
  ])
  const geometryBlockedReason =
    frameBlockedReason ??
    (selectedContract && !usesExperimentCoordinates(selectedContract.visualization)
      ? '이 결과는 Geometry 좌표계의 공간 표시를 지원하지 않습니다.'
      : undefined)
  const canOverlayGeometry = !geometryBlockedReason
  const sceneDocument = !resultPlaceholder && selectedView !== '' && !canOverlayGeometry ? null : viewerDocument
  const recordReference = useMemo(() => {
    if (!calculationSource) return undefined
    try {
      return calculationExperimentRecordReference(calculationSource, selectedView)
    } catch {
      return undefined
    }
  }, [calculationSource, selectedView])
  const gridAxis =
    selectedContract?.visualization.kind === 'box-grid' ? 0 : selectedContract?.visualization.grid?.xyzAxes[0]
  const gridUnit =
    gridAxis === undefined
      ? undefined
      : recordedRules.find((rule) => rule.label === selectedView)?.result.axes?.[gridAxis]?.unit
  const displayUnit =
    sceneDocument?.scene?.lengthUnit ??
    selectedField?.lengthUnit ??
    selectedMotion?.lengthUnit ??
    selectedParticles?.lengthUnit ??
    gridUnit ??
    'm'
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
        usesExperimentCoordinates(resultContracts![bundle.id].visualization) &&
        (!selectedContract || usesExperimentCoordinates(selectedContract.visualization))),
  )
  const renderScene = (
    meshRenderData?: MeshRenderData,
    deformationScale = 0,
    heatmapRenderData?: HeatmapRenderData,
    geometryOpacity = 1,
    showParticleGeometry = false,
  ) => (
    <>
      {deformationScale > 0 && selectedLines.length ? (
        <p role="status" className="bg-amber-50 p-2 text-xs">
          변형 표시 중에는 원래 좌표의 polyline Overlay를 표시하지 않습니다.
        </p>
      ) : null}
      <CadViewer
        activeExperimentTaskName={activeExperimentTaskName ? experimentTaskName(activeExperimentTaskName) : null}
        experiment={
          deformationScale > 0 || selectedMotion || (selectedParticles && !showParticleGeometry) ? null : sceneDocument
        }
        onFindSelectionSource={onFindSelectionSource}
        onRenderEnd={experimentDocument.handleRenderEnd}
        onRenderError={experimentDocument.handleRenderError}
        onRenderStart={experimentDocument.handleRenderStart}
        onSelectionQueryChange={onSelectionQueryChange}
        onSelectionSourcePathsChange={onSelectionSourcePathsChange}
        polylines={deformationScale > 0 || selectedMotion ? [] : selectedLines}
        meshRenderData={meshRenderData}
        heatmapRenderData={heatmapRenderData}
        geometryOpacity={geometryOpacity}
        meshIdentity={selectedField?.identity ?? selectedMotion?.identity ?? selectedParticles?.identity}
        displayUnit={displayUnit}
        preserveCameraOnUpdate={
          Boolean(comparison) || autoSelectResult || Boolean(selectedMotion) || Boolean(selectedParticles)
        }
        selectionQuery={selectionQuery}
        selectionSourceStatus={selectionSourceStatus}
        onToggleViewerExpanded={onToggleViewerExpanded}
        viewerExpanded={viewerExpanded}
      />
    </>
  )
  return (
    <ViewerPersistenceContext.Provider value={persistent ? { ...persistent, item: selectedView } : null}>
      <div className="relative flex h-full min-h-0 flex-col">
        {presentation ? (
          <div className="flex justify-end border-b p-1" data-capture-exclude>
            <ViewerPresentationMenu
              key={presentation.experimentId}
              actions={presentation}
              disabled={loading || Boolean(resultPlaceholder)}
              captureNode={() => localCaptureRef.current}
              snapshot={() => {
                const owner = comparison ?? persistent
                const camera = cameraPoseSchema.safeParse(owner?.camera.current)
                return {
                  version: 1,
                  selectedResult: selectedView,
                  settings: durableViewerSettings(owner?.settings.values.entries() ?? []),
                  camera: camera.success ? camera.data : null,
                }
              }}
            />
          </div>
        ) : null}
        <ViewerControls>
          <div className="flex flex-wrap items-center gap-3 border-b bg-white p-2 text-xs">
            {showToolbar ? (
              <select
                aria-label="Viewer 결과 선택"
                value={selectedView}
                onChange={(event) => {
                  selectionMade.current.add(scope)
                  setSelections({ ...selections, [scope]: event.target.value })
                  onSelectedResultChange?.(event.target.value)
                }}
              >
                <option value="">Geometry</option>
                {selectedView && !selectedContract ? (
                  <option value={selectedView}>{selectedView} · 결과 없음</option>
                ) : null}
                {Object.keys(resultContracts ?? {}).map((name) => (
                  <option key={name} value={name}>
                    {name.startsWith('@visualizations.')
                      ? `${name.slice('@visualizations.'.length)} · 시각화`
                      : `${name} · Output`}
                  </option>
                ))}
              </select>
            ) : null}
            {Object.entries(resultContracts ?? {})
              .filter(([, result]) => result.visualization.kind === 'polyline')
              .map(([name, result]) => {
                const compatible =
                  sameResultInvocation(name) &&
                  polylines.bundles.some((bundle) => bundle.id === name) &&
                  frameMatches &&
                  usesExperimentCoordinates(result.visualization) &&
                  (!selectedContract || usesExperimentCoordinates(selectedContract.visualization))
                return (
                  <label
                    key={name}
                    title={
                      compatible
                        ? 'Geometry 좌표에 겹쳐 표시'
                        : (geometryBlockedReason ?? '선택 결과와 좌표계를 연결할 수 없습니다.')
                    }
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
                저장 결과 불러오는 중
                {downloadProgress ? ` · ${downloadProgress.completed}/${downloadProgress.total}` : '…'}
              </span>
            ) : null}
            {!resultContracts && recordedRules.length ? (
              <span role="status">이전 결과 계약은 새 Viewer에서 지원하지 않습니다.</span>
            ) : null}
          </div>
        </ViewerControls>
        {resultPlaceholder ? (
          <p role="status" className="p-2 text-xs">
            {resultPlaceholder}
          </p>
        ) : null}
        {!resultPlaceholder && !canOverlayGeometry && selectedView !== '' && !selectedMotion ? (
          <p role="status" className="p-2 text-xs">
            {geometryBlockedReason}
          </p>
        ) : null}
        <div ref={localCaptureRef} className="min-h-0 flex-1 overflow-auto">
          {resultPlaceholder ? (
            renderScene()
          ) : selectedView && !selectedContract ? (
            <p role="alert" className="p-3 text-red-700">
              {selectedView}: 새 실행에 선택한 결과가 없습니다.
            </p>
          ) : resultErrors[selectedView] ? (
            <p role="alert" className="p-3 text-red-700">
              {selectedView}: {resultErrors[selectedView]}
            </p>
          ) : selectedParticles ? (
            <ParticleSetResult
              key={selectedView}
              particles={selectedParticles}
              displayUnit={displayUnit}
              canOverlayGeometry={canOverlayGeometry}
              renderViewer={(data, showGeometry) => renderScene(data, 0, undefined, 1, showGeometry)}
            />
          ) : selectedMotion ? (
            <MeshTransformResult
              key={selectedView}
              motion={selectedMotion}
              displayUnit={displayUnit}
              renderViewer={(data) => renderScene(data)}
            />
          ) : selectedField ? (
            <MeshFieldResult
              key={selectedView}
              field={selectedField}
              displacementFields={mesh.fields.filter((candidate) => sameResultInvocation(candidate.label))}
              displayUnit={displayUnit}
              renderViewer={(data, view) => renderScene(data, view.deformationScale)}
            />
          ) : selectedContract?.visualization.kind === 'box-grid' ? (
            <BoxGridResult
              key={selectedView}
              name={selectedView}
              rules={recordedRules}
              data={recordedData}
              displayUnit={displayUnit}
              canOverlayGeometry={canOverlayGeometry}
              geometryBlockedReason={geometryBlockedReason}
              renderViewer={(data, geometryOpacity) => renderScene(undefined, 0, data, geometryOpacity)}
              recordReference={recordReference}
            />
          ) : selectedContract &&
            !['mesh-field', 'mesh-transform', 'polyline', 'particle-set'].includes(
              selectedContract.visualization.kind,
            ) ? (
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
          ...transforms.errors.filter((error) => !resultErrors[error.label]),
          ...particles.errors.filter((error) => !resultErrors[error.label]),
          ...polylines.errors.filter((error) => !resultErrors[error.label]),
        ]
          .filter((error) => error.label !== selectedView || !resultErrors[selectedView])
          .map((error) => (
            <p role="alert" key={error.label} className="bg-rose-50 p-2 text-xs text-red-700">
              {error.label}: {error.message}
            </p>
          ))}
      </div>
    </ViewerPersistenceContext.Provider>
  )
}
