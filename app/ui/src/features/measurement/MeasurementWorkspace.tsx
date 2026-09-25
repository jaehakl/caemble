import { useViewerSelectionStore, type ViewerSelectionStore } from '@/features/viewer/viewer/viewerSelection'
import { SharedViewerDisplayControls, ViewerResultMenuHost } from '@/features/viewer/viewer/ViewerDisplayControls'
import { initialViewerDisplay } from '@/features/viewer/viewer/viewerDisplay'
import { ViewerLayout } from '@/features/viewer/viewer/ViewerTools'
import { ViewerControls } from '@/features/viewer/viewer/comparisonSettings'
import { Play, Square, BrainCircuit } from 'lucide-react'
import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'
import { ComparisonToolbar } from '@/features/viewer/viewer/ComparisonToolbar'
import {
  WorkbenchRibbon,
  WorkbenchRibbonButton,
  WorkbenchRibbonGroup,
} from '@/features/cae-workbench/chrome/WorkbenchRibbon'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import {
  createViewerSettings,
  ViewerPersistenceContext,
  type ViewerComparison,
} from '@/features/viewer/viewer/comparisonSettings'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { varsFingerprint } from '@/lib/cad/model/vars'
import { materialVarsHash } from '@/lib/material/resolution'
import { createCadSourceDocument } from '@/lib/cad/source'
import type { MeasurementSession } from './useMeasurementSession'
import { MeasurementSplit } from './MeasurementSplit'
import { MeasurementVarsEditor } from './MeasurementVarsEditor'
import { MeasurementPcaChart } from './MeasurementPcaChart'
import { projectSpace, spaceVars, spaceValues, varsAtProjection, type MeasurementProjection } from './measurementSpace'

const controlClass =
  'h-9 shrink-0 rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45'

export function MeasurementWorkspace({
  selectionStore,
  workbench,
  session,
  dataReadable,
  active,
  menubar,
  onActivity,
}: {
  workbench: CaeWorkbenchState
  selectionStore?: ViewerSelectionStore
  session: MeasurementSession
  dataReadable: boolean
  active: boolean
  menubar: ReactNode
  onActivity?: RuntimeActivityCallback
}) {
  const localSelection = useViewerSelectionStore(workbench.workspaceSession)
  const selection = selectionStore ?? localSelection
  const {
    vars,
    currentId,
    selected,
    valid,
    error,
    operation,
    previewFrame,
    recordedDocuments,
    execution,
    actual,
    document,
    schema,
    schemaKey,
    query,
    measurements,
    currentKey,
    ready,
    busy,
    persistable,
    canDeleteMeasurements,
    forward,
    points,
    setValid,
    setPreviewFrame,
    changeVars,
    selectPoint: selectSessionPoint,
    deleteSelectedMeasurements,
    run,
    cancel,
  } = session
  const [selectedVar, setSelectedVar] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState(() => {
    const defaults = workbench.experimentRecord?.viewer_defaults
    return defaults?.version === 2 ? defaults.selectedOutput : ''
  })
  const [comparisonSettings] = useState(() => createViewerSettings(workbench.experimentRecord?.viewer_defaults))
  const viewerSettings = useMemo(() => ({ ...comparisonSettings, selection }), [comparisonSettings, selection])
  const [resultHosts, updateResultHosts] = useState<Record<string, HTMLElement>>({})
  const setResultHost = useCallback(
    (name: string, host: HTMLDivElement | null) =>
      updateResultHosts((current) => {
        if ((current[name] ?? null) === host) return current
        const next = { ...current }
        if (host) next[name] = host
        else delete next[name]
        return next
      }),
    [],
  )
  const controlsHost = null
  const [camera] = useState(() => createComparisonCamera(workbench.experimentRecord?.viewer_defaults?.camera))
  const defaultResult = useRef(
    workbench.experimentRecord?.viewer_defaults
      ? initialViewerDisplay(workbench.experimentRecord.viewer_defaults).output
      : undefined,
  )
  const resultSelectionMade = useRef(false)
  const [pcaRevision, setPcaRevision] = useState(0)
  const [projection, setProjection] = useState<MeasurementProjection | null>(null)
  const [pcaError, setPcaError] = useState('')
  const [pcaBusy, setPcaBusy] = useState(false)
  const worker = useRef<Worker | null>(null)
  const pcaSequence = useRef(0)
  const recordedSource = useMemo(
    () =>
      workbench.experimentRecord?.source_bundle
        ? createCadSourceDocument('experiment', workbench.experimentRecord.source_bundle)
        : workbench.experiment,
    [workbench.experimentRecord?.source_bundle, workbench.experiment],
  )
  const { experimentDocument: actualDocument } = useCadWorkspace(
    actual.measurement && !recordedDocuments[actual.measurement.id] ? recordedSource : null,
    undefined,
    {
      candidateVars: actual.variables,
      candidateProvenance: 'persisted-measurement',
      persistedMaterialSnapshot: actual.materialSnapshot,
      resetKey: workbench.workspaceSession,
      onActivity,
    },
  )
  const previewDocument = previewFrame?.document ?? document
  const previewData = previewFrame ? previewFrame.data : forward.data
  const displayedActualDocument = (actual.measurement && recordedDocuments[actual.measurement.id]) || actualDocument
  const comparisonContracts = {
    ...previewDocument.simulationProgram?.resultContracts,
    ...actual.resultContracts,
    ...visualizationData(actual.visualizations ?? {}).contracts,
  }
  const preferredResultAvailable =
    defaultResult.current === '' || Boolean(comparisonContracts[defaultResult.current ?? ''])
  useEffect(() => {
    if (resultSelectionMade.current || workbench.selectionRestoring || actual.loading) return
    if (workbench.selection.measurement?.recorded_at && !actual.measurement) return
    if (!actual.measurement && !ready) return
    resultSelectionMade.current = true
    if (preferredResultAvailable && defaultResult.current !== undefined) setSelectedResult(defaultResult.current)
  }, [
    preferredResultAvailable,
    actual.loading,
    actual.measurement,
    ready,
    workbench.selectionRestoring,
    workbench.selection.measurement?.recorded_at,
  ])
  const actualHasSelectedData =
    Object.keys(actual.flatRecordedData ?? {}).some(
      (name) => name === selectedResult || name.startsWith(`${selectedResult}.`),
    ) || selectedResult.startsWith('@visualizations.')
  const controlsSide =
    actual.measurement &&
    (!previewData?.[selectedResult] || (actualHasSelectedData && !actual.resultErrors?.[selectedResult])) &&
    (!selectedResult || actual.resultContracts?.[selectedResult] || selectedResult.startsWith('@visualizations.'))
      ? 'actual'
      : 'preview'
  const comparison = useMemo(() => {
    const common = {
      settings: viewerSettings,
      item: selectedResult,
      controlsHost,
      suspended: !active || (!previewFrame && (!ready || forward.predicting)),
    }
    return {
      preview: {
        ...common,
        side: 'preview',
        controlsOwner: controlsSide === 'preview',
        camera,
      } as ViewerComparison,
      actual: {
        ...common,
        side: 'actual',
        controlsOwner: controlsSide === 'actual',
        camera,
      } as ViewerComparison,
    }
  }, [
    viewerSettings,
    camera,
    selectedResult,
    controlsHost,
    active,
    ready,
    forward.predicting,
    controlsSide,
    previewFrame,
  ])
  const pointsRef = useRef(points)
  pointsRef.current = points
  const varsRef = useRef(vars)
  varsRef.current = vars
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

  useEffect(() => {
    const instance = new Worker(new URL('./measurementSpace.worker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    instance.onmessage = (event: MessageEvent<{ id: number; projection?: MeasurementProjection; error?: string }>) => {
      if (event.data.id !== pcaSequence.current) return
      setProjection(event.data.projection ?? null)
      setPcaError(event.data.error ?? '')
      setPcaBusy(false)
    }
    instance.onerror = () => {
      setPcaError('PCA Worker 오류입니다. 탭을 다시 열거나 새로고침하세요.')
      setPcaBusy(false)
    }
    return () => {
      worker.current = null
      instance.terminate()
    }
  }, [])
  useEffect(() => {
    if (!schema || !worker.current) return
    setPcaBusy(true)
    const input = [...pointsRef.current]
    if (
      currentIdRef.current === 'draft' &&
      varsRef.current &&
      !input.some((point) => varsFingerprint(point.vars) === varsFingerprint(varsRef.current))
    )
      input.push({ id: 'draft', vars: varsRef.current })
    worker.current.postMessage({ id: ++pcaSequence.current, schema, points: input })
    // Editing projects into the existing snapshot; only membership/data refreshes rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, measurements, pcaRevision])

  const selectPoint = (id: string, additive: boolean) => {
    const point = id === 'draft' ? projection?.points.find((point) => point.id === id) : null
    return selectSessionPoint(
      id,
      additive,
      point && projection ? spaceVars(projection.layouts, point.values) : undefined,
    )
  }

  const chartPoints =
    projection?.points.map((point) => {
      const row = measurements.find((row) => point.id === `measurement:${row.id}`)
      const progress = execution[point.id]
      return {
        id: point.id,
        xy: point.xy,
        label: row ? `Measurement #${row.id}` : '현재 Vars',
        state: row?.recorded_at
          ? 'recorded'
          : progress
            ? progress.state === 'succeeded'
              ? 'recorded'
              : progress.state === 'failed' || progress.state === 'cancelled'
                ? progress.state
                : 'running'
            : row
              ? 'prepared'
              : 'candidate',
      }
    }) ?? []
  let currentProjection: number[] | undefined
  try {
    if (projection && vars) currentProjection = projectSpace(projection, spaceValues(projection.layouts, vars))
  } catch {
    /* A new schema waits for its matching PCA snapshot. */
  }
  const viewerBase = {
    initialDefaults: workbench.experimentRecord?.viewer_defaults,
    experiment: workbench.experiment,
    selectedResult,
    onSelectedResultChange: setSelectedResult,
    showToolbar: false,
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {menubar}
      <WorkbenchRibbon
        activeSectionId="measurement"
        panels={[
          {
            sectionId: 'measurement',
            label: 'Measurement',
            content: (
              <>
                <WorkbenchRibbonGroup label="시뮬레이션 실행">
                  {operation && operation !== '저장 중' && operation !== '삭제 중' ? (
                    <WorkbenchRibbonButton size="large" icon={<Square />} label="취소" onClick={cancel} />
                  ) : (
                    <WorkbenchRibbonButton
                      size="large"
                      icon={<Play />}
                      label="실행"
                      disabled={
                        !persistable ||
                        !ready ||
                        !valid ||
                        busy ||
                        Boolean(measurements.find((row) => `measurement:${row.id}` === currentId)?.recorded_at)
                      }
                      onClick={() => void run()}
                    />
                  )}
                </WorkbenchRibbonGroup>
                <WorkbenchRibbonGroup label="예측 모델">
                  <WorkbenchRibbonButton
                    size="large"
                    icon={<BrainCircuit />}
                    label={forward.building ? '모델 생성 중…' : forward.model ? '모델 업데이트' : '예측 모델 생성'}
                    disabled={!dataReadable || !ready || forward.building || busy}
                    onClick={() => {
                      setPreviewFrame(null)
                      void forward.build()
                    }}
                  />
                  <span className="max-w-40 text-xs text-muted-foreground">
                    {operation ??
                      workbench.measurementActions.stage ??
                      (forward.outdated
                        ? '새 데이터 · 모델 업데이트 필요'
                        : forward.model
                          ? '예측 모델 준비됨'
                          : '예측 모델 없음')}
                  </span>
                </WorkbenchRibbonGroup>
              </>
            ),
          },
        ]}
      />
      {!persistable ? (
        <p className="border-b px-3 py-1 text-xs text-muted-foreground">
          실행·저장에는 로그인과 저장된 편집 가능한 Experiment가 필요합니다.
        </p>
      ) : null}
      {error || workbench.measurementActions.error || query.isError ? (
        <p role="alert" className="border-b px-3 py-1 text-xs text-destructive">
          {error || workbench.measurementActions.error || 'Measurement를 불러오지 못했습니다.'}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <MeasurementSplit
          label="Measurement 좌우 너비 조절"
          first={
            <MeasurementSplit
              vertical
              label="PCA와 Vars 높이 조절"
              first={
                <section className="flex h-full min-h-0 flex-col">
                  <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
                    <strong>Vars PCA</strong>
                    <span>{measurements.length} Measurements</span>
                    <button
                      className={controlClass}
                      disabled={!schema || pcaBusy || !valid}
                      onClick={() => setPcaRevision((value) => value + 1)}
                    >
                      PCA 갱신
                    </button>
                    <button
                      className={controlClass}
                      disabled={!canDeleteMeasurements}
                      onClick={() => void deleteSelectedMeasurements()}
                    >
                      선택 Measurement 삭제
                    </button>
                    {pcaBusy ? <span>계산 중…</span> : null}
                  </header>
                  {pcaError ? (
                    <p role="alert" className="p-2 text-xs text-destructive">
                      {pcaError}
                    </p>
                  ) : null}
                  <MeasurementPcaChart
                    projection={projection}
                    points={chartPoints}
                    current={currentProjection}
                    selected={selected}
                    disabled={!valid || busy || pcaBusy}
                    onSelect={(id, additive) => void selectPoint(id, additive)}
                    onSpace={(xy) => {
                      if (projection) changeVars(varsAtProjection(projection, xy))
                    }}
                  />
                  <label className="flex shrink-0 items-center gap-2 border-t p-2 text-xs">
                    점 선택
                    <select
                      className={`${controlClass} min-w-0 flex-1`}
                      value={currentId}
                      disabled={!valid || busy}
                      onChange={(event) => void selectPoint(event.target.value, false)}
                    >
                      <option value="draft">현재 Vars</option>
                      {measurements.map((row) => (
                        <option key={row.id} value={`measurement:${row.id}`}>
                          #{row.id} · {row.recorded_at ? 'Recorded' : 'Prepared'}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
              }
              second={
                <MeasurementVarsEditor
                  schema={schema}
                  vars={vars}
                  selectedKey={selectedVar}
                  onSelectedKeyChange={setSelectedVar}
                  onVarsChange={changeVars}
                  onValidityChange={setValid}
                  disabled={busy}
                />
              }
            />
          }
          second={
            <ViewerPersistenceContext.Provider value={{ settings: viewerSettings, camera, item: selectedResult }}>
              <ViewerResultMenuHost.Provider value={resultHosts}>
                <ViewerLayout>
                  <ViewerControls placement="data">
                    <SharedViewerDisplayControls
                      contracts={comparisonContracts}
                      output={selectedResult}
                      onOutput={(name) => {
                        resultSelectionMade.current = true
                        setSelectedResult(name)
                      }}
                      resultHost={setResultHost}
                    />
                  </ViewerControls>
                  <ComparisonToolbar camera={camera} />
                  <div className="h-full min-h-0">
                    <MeasurementSplit
                      label="미리보기와 실제 결과 너비 조절"
                      first={
                        <section aria-label="미리보기 Viewer" className="flex h-full min-h-0 flex-col">
                          <header className="shrink-0 border-b p-2 text-xs">
                            <strong>미리보기 · {previewFrame ? '실행 당시 Vars' : '현재 Vars'}</strong>
                            <span className="ml-2 text-muted-foreground">
                              {previewFrame
                                ? previewFrame.error || (previewFrame.data ? 'Forward 예측 · 실행 전' : 'CAD')
                                : !ready
                                  ? '구조 평가 중…'
                                  : forward.predicting
                                    ? 'Forward 갱신 중…'
                                    : forward.model
                                      ? 'Forward 예측'
                                      : '구조 · 모델을 생성하면 Output을 예측합니다.'}
                            </span>
                            {previewDocument.error ? (
                              <p role="alert" className="text-destructive">
                                {previewDocument.error.message}
                              </p>
                            ) : null}
                            {!previewFrame && forward.error ? (
                              <p role="alert" className="text-destructive">
                                {forward.error}
                              </p>
                            ) : null}
                            {!previewFrame &&
                              forward.model &&
                              Object.values(forward.model.errors).map((message, index) => (
                                <p className="text-muted-foreground" key={index}>
                                  {message}
                                </p>
                              ))}
                          </header>
                          <div className="min-h-0 flex-1">
                            <WorkbenchViewer
                              onActivity={onActivity}
                              {...viewerBase}
                              comparison={comparison.preview}
                              experimentDocument={previewDocument}
                              resultContracts={previewDocument.simulationProgram?.resultContracts}
                              recordedData={previewData}
                              recordedRules={previewFrame ? previewFrame.rules : forward.model?.rules}
                              resultSourceHash={previewDocument.evaluatedSnapshot?.sourceHash}
                              resultVarsHash={
                                (previewFrame?.vars ?? vars) ? materialVarsHash((previewFrame?.vars ?? vars)!) : null
                              }
                              loading={!previewFrame && (!ready || forward.predicting)}
                              selectedResult={previewFrame && !previewFrame.data ? '' : selectedResult}
                            />
                          </div>
                        </section>
                      }
                      second={
                        <section aria-label="실제 결과 Viewer" className="flex h-full min-h-0 flex-col">
                          <header className="shrink-0 border-b p-2 text-xs">
                            <strong>
                              실제 결과 {actual.measurement ? `· Measurement #${actual.measurement.id}` : ''}
                            </strong>
                            {actual.variables && varsFingerprint(actual.variables) !== currentKey ? (
                              <span className="ml-2 text-amber-700">비교 기준 · 현재 Vars와 다름</span>
                            ) : null}
                            {displayedActualDocument.error ? (
                              <p role="alert" className="text-destructive">
                                {displayedActualDocument.error.message}
                              </p>
                            ) : null}
                          </header>
                          <div className="min-h-0 flex-1">
                            {actual.measurement || actual.loading ? (
                              <WorkbenchViewer
                                onActivity={onActivity}
                                {...viewerBase}
                                presentation={
                                  workbench.viewerPresentation
                                    ? {
                                        ...workbench.viewerPresentation,
                                        measurementId: actual.measurement?.id ?? null,
                                        canSaveInitialView:
                                          workbench.experimentClean &&
                                          Boolean(actual.measurement?.recorded_at) &&
                                          !actual.loading,
                                      }
                                    : undefined
                                }
                                comparison={comparison.actual}
                                experimentDocument={displayedActualDocument}
                                resultContracts={actual.resultContracts}
                                recordedData={actual.flatRecordedData}
                                recordedRules={actual.recordedRules}
                                resultErrors={actual.resultErrors}
                                visualizations={actual.visualizations}
                                resultSourceHash={actual.materialSnapshot?.sourceHash}
                                resultVarsHash={actual.materialSnapshot?.varsHash}
                                loading={actual.loading && !actual.measurement}
                                downloadProgress={actual.downloadProgress}
                              />
                            ) : (
                              <p className="grid h-full place-items-center p-3 text-sm text-muted-foreground">
                                Recorded Measurement를 선택하면 실제 결과를 표시합니다.
                              </p>
                            )}
                          </div>
                        </section>
                      }
                    />
                  </div>
                </ViewerLayout>
              </ViewerResultMenuHost.Provider>
            </ViewerPersistenceContext.Provider>
          }
        />
      </div>
    </div>
  )
}
