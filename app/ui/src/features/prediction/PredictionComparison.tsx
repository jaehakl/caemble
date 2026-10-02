import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import type { CaeDataSelection } from '@/features/measurement/useCaeDataSelection'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'
import { ComparisonToolbar } from '@/features/viewer/viewer/ComparisonToolbar'
import {
  createViewerSettings,
  ViewerControls,
  ViewerPersistenceContext,
  type ViewerComparison,
} from '@/features/viewer/viewer/comparisonSettings'
import { SharedViewerDisplayControls, ViewerResultMenuHost } from '@/features/viewer/viewer/ViewerDisplayControls'
import { ViewerLayout } from '@/features/viewer/viewer/ViewerTools'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { initialViewerDisplay } from '@/features/viewer/viewer/viewerDisplay'
import { varsFingerprint } from '@caemble/execution/cad/model/vars'
import { createCadSourceDocument } from '@caemble/execution/cad/source'
import { ResizableSplit } from '@/shared/layout/ResizableSplit'
import type { PredictionViewerState } from './PredictionWorkspace'

type ActualSnapshot = {
  selection: CaeDataSelection
  source: CaeWorkbenchState['experiment']
}

export function PredictionComparison({
  workbench,
  prediction,
  status,
  active,
  onActivity,
}: {
  workbench: CaeWorkbenchState
  prediction: PredictionViewerState | null
  status: string
  active: boolean
  onActivity?: RuntimeActivityCallback
}) {
  const candidateSourceHash =
    workbench.experimentDocument.predictionCandidate?.sourceHash ??
    workbench.experimentDocument.evaluatedSnapshot?.sourceHash
  const preview =
    prediction?.varsFingerprint === varsFingerprint(workbench.candidateVars) &&
    prediction.sourceHash === candidateSourceHash
      ? prediction
      : null
  const [actual, setActual] = useState<ActualSnapshot | null>(null)
  const selection = workbench.selection
  const savedSource = workbench.experimentRecord?.source_bundle
  const source = useMemo(
    () => (savedSource ? createCadSourceDocument('experiment', savedSource) : workbench.experiment),
    [savedSource, workbench.experiment],
  )
  // Selection publishes a complete Recorded snapshot atomically. Null, pending and failed
  // selections must leave the previous comparison result intact.
  useLayoutEffect(() => {
    if (
      selection.loading ||
      !selection.measurement?.recorded_at ||
      selection.measurement.experiment_id !== workbench.experimentId
    )
      return
    setActual((previous) => {
      if (
        previous?.selection.measurement === selection.measurement &&
        previous.selection.flatRecordedData === selection.flatRecordedData
      )
        return previous
      return {
        selection,
        source: previous && previous.selection.measurement?.id === selection.measurement?.id ? previous.source : source,
      }
    })
  }, [selection, source, workbench.experimentId])
  const recorded = actual?.selection
  const { experimentDocument: actualDocument } = useCadWorkspace(actual?.source ?? null, undefined, {
    candidateVars: recorded?.variables,
    candidateProvenance: 'persisted-measurement',
    persistedMaterialSnapshot: recorded?.materialSnapshot,
    resetKey: workbench.workspaceSession,
    onActivity,
  })
  const actualReady = Boolean(
    recorded &&
    actualDocument.successfulRevision === actualDocument.revision &&
    varsFingerprint(actualDocument.variables) === varsFingerprint(recorded.variables ?? null) &&
    (actualDocument.status === 'Ready' || actualDocument.status === 'Rendering'),
  )
  const defaults = workbench.experimentRecord?.viewer_defaults
  const [settings] = useState(() => createViewerSettings(defaults))
  const [camera] = useState(() => createComparisonCamera(defaults?.camera))
  const [selectedResult, setSelectedResult] = useState(() => initialViewerDisplay(defaults).output)
  const [resultHosts, updateResultHosts] = useState<Record<string, HTMLElement>>({})
  const setResultHost = useCallback((name: string, host: HTMLDivElement | null) => {
    updateResultHosts((current) => {
      if ((current[name] ?? null) === host) return current
      const next = { ...current }
      if (host) next[name] = host
      else delete next[name]
      return next
    })
  }, [])
  const previewContracts =
    preview?.preview.resultContracts ?? workbench.experimentDocument.simulationProgram?.resultContracts
  const contracts = {
    ...previewContracts,
    ...recorded?.resultContracts,
    ...visualizationData(recorded?.visualizations ?? {}).contracts,
  }
  const actualHasSelectedData =
    Object.keys(recorded?.flatRecordedData ?? {}).some(
      (name) => name === selectedResult || name.startsWith(`${selectedResult}.`),
    ) || selectedResult.startsWith('@visualizations.')
  const actualOwnsControls = Boolean(
    actualReady &&
    (!preview?.preview.recorded[selectedResult] ||
      (actualHasSelectedData && !recorded?.resultErrors[selectedResult])) &&
    (!selectedResult || recorded?.resultContracts?.[selectedResult] || selectedResult.startsWith('@visualizations.')),
  )
  const common = { settings, camera, item: selectedResult, controlsHost: null, suspended: !active }
  const comparison: { preview: ViewerComparison; actual: ViewerComparison } = {
    preview: { ...common, side: 'preview', controlsOwner: !actualOwnsControls },
    actual: { ...common, side: 'actual', controlsOwner: actualOwnsControls },
  }
  const viewerBase = {
    initialDefaults: defaults,
    selectedResult,
    onSelectedResultChange: setSelectedResult,
    showToolbar: false,
    onActivity,
  }
  return (
    <ViewerPersistenceContext.Provider value={{ settings, camera, item: selectedResult }}>
      <ViewerResultMenuHost.Provider value={resultHosts}>
        <ViewerLayout>
          <ViewerControls placement="data">
            <SharedViewerDisplayControls
              contracts={contracts}
              output={selectedResult}
              onOutput={setSelectedResult}
              resultHost={setResultHost}
            />
          </ViewerControls>
          <ComparisonToolbar camera={camera} />
          <ResizableSplit
            label="예측과 실제 결과 너비 조절"
            first={
              <section aria-label="예측 Viewer" className="flex h-full min-h-0 flex-col">
                <header className="shrink-0 border-b p-2 text-xs">
                  <strong>예측 · 현재 Vars</strong>
                  <p className="truncate text-muted-foreground" title={status}>
                    {status}
                  </p>
                  {!preview ||
                  (selectedResult &&
                    !Object.keys(preview.preview.recorded).some(
                      (name) => name === selectedResult || name.startsWith(`${selectedResult}.`),
                    )) ? (
                    <p className="text-muted-foreground">
                      {selectedResult ? '선택한 Output의 예측 결과가 없습니다.' : '현재 Vars의 예측 결과가 없습니다.'}
                    </p>
                  ) : null}
                </header>
                <div className="min-h-0 flex-1">
                  <WorkbenchViewer
                    {...viewerBase}
                    comparison={comparison.preview}
                    experiment={workbench.experiment}
                    experimentDocument={workbench.experimentDocument}
                    onGeometryRequiredChange={workbench.setPredictionGeometryRequired}
                    resultContracts={previewContracts}
                    recordedData={preview?.preview.recorded}
                    recordedRules={preview?.preview.rules}
                    resultSourceHash={preview?.sourceHash}
                    resultVarsHash={preview?.varsHash}
                    resultPlaceholder={!preview ? '현재 Vars의 예측 결과가 없습니다.' : undefined}
                  />
                </div>
              </section>
            }
            second={
              <section aria-label="실제 결과 Viewer" className="flex h-full min-h-0 flex-col">
                <header className="shrink-0 border-b p-2 text-xs">
                  <strong>실제 결과{recorded?.measurement ? ` · Measurement #${recorded.measurement.id}` : ''}</strong>
                  {recorded?.variables &&
                  varsFingerprint(recorded.variables ?? null) !== varsFingerprint(workbench.candidateVars) ? (
                    <p className="text-amber-700">비교 기준 · 현재 Vars와 다름</p>
                  ) : null}
                </header>
                <div className="min-h-0 flex-1">
                  {recorded && actualReady ? (
                    <WorkbenchViewer
                      {...viewerBase}
                      comparison={comparison.actual}
                      experiment={actual!.source}
                      experimentDocument={actualDocument}
                      resultContracts={recorded.resultContracts}
                      recordedData={recorded.flatRecordedData}
                      recordedRules={recorded.recordedRules}
                      resultErrors={recorded.resultErrors}
                      visualizations={recorded.visualizations}
                      resultSourceHash={recorded.materialSnapshot?.sourceHash}
                      resultVarsHash={recorded.materialSnapshot?.varsHash}
                    />
                  ) : (
                    <p className="grid h-full place-items-center p-3 text-sm text-muted-foreground">
                      {recorded
                        ? actualDocument.status === 'Error'
                          ? '실제 결과의 형상을 표시할 수 없습니다.'
                          : '실제 결과의 형상을 준비하는 중입니다.'
                        : 'Recorded Measurement를 선택하거나 Save & Run을 실행하세요.'}
                    </p>
                  )}
                </div>
              </section>
            }
          />
        </ViewerLayout>
      </ViewerResultMenuHost.Provider>
    </ViewerPersistenceContext.Provider>
  )
}
