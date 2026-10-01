import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useState, type PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { CalculationDataOutput } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { BrowserBatchCandidates } from '@/features/measurement/buildBatchArtifact'
import type { CandidateBatchProgress } from '@/features/measurement/useCaeMeasurementActions'
import {
  PredictionWorkspace,
  type PredictionWorkspaceCommand,
  type PredictionWorkspaceChromeState,
} from './PredictionWorkspace'
import type { PredictionRecordedPreview, PredictionSetup } from './usePredictionModels'
import { PredictionTrainingChangedError } from './trainingSnapshot'
import { persistPredictionSetup } from './setupPersistence'
import { defaultPredictionSetup } from './usePredictionModels'
import { PredictionRuntimeController } from './usePredictionController'
import type { PredictionDeletionTarget } from './assetManagement'

const mocks = vi.hoisted(() => ({
  manageable: true,
  queryScope: 'user:test',
  predictionOnly: false,
  calculateMeasurement: vi.fn(),
  calculateMissing: () => {},
  applySavedSetup: (_setup: PredictionSetup, _direction?: 'forward' | 'inverse') => {},
  deleteTarget: undefined as ((target: PredictionDeletionTarget) => Promise<void>) | undefined,
  calculationSource: 'calculation-source',
  contextFingerprint: 'before',
  forwardOutputs: vi.fn(),
  viewerState: vi.fn(),
  chromeState: vi.fn(),
  setCandidate: vi.fn(),
  loadContextData: vi.fn(),
  selectedTargets: vi.fn(),
  samplingMeasurements: vi.fn(),
  startSampling: vi.fn(),
  selectedMeasurementId: null as number | null,
  loadContextFingerprint: vi.fn(),
  predictInverse: vi.fn(),
  saveAndRun: vi.fn(),
  runCandidates: vi.fn(),
  nextSample: vi.fn(),
  acceptSample: vi.fn(),
  workerCreated: vi.fn(),
  actual: null as CalculationDataOutput | null,
  actualSource: 'calculation-source',
}))

vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => mocks.queryScope }))
vi.mock('@/lib/calculation', () => ({ calculationSourceHash: async () => 'calculation-source' }))
vi.mock('../experiment/queryOptions', () => ({
  availableExperimentsQueryOptions: () => ({
    queryKey: ['prediction-test-experiments'],
    queryFn: async () => ({ demos: [], mine: [] }),
  }),
}))
vi.mock('./client', () => ({
  PredictionWorkerClient: class {
    constructor() {
      mocks.workerCreated()
    }
    epoch = 0
    cancelPending() {
      return false
    }
    dispose() {}
    reset() {}
    startSampling = mocks.startSampling
    nextSample = mocks.nextSample
    acceptSample = mocks.acceptSample
    async dropSampling() {}
  },
  PredictionWorkerRestartError: class extends Error {},
}))
vi.mock('./diagnostics', () => ({ emitPredictionCohortDiagnostics: () => undefined }))
vi.mock('./usePredictionAssets', () => ({
  usePredictionAssets: () => ({
    currentSelectionKey: '',
    getSnapshot: () => ({ models: [] }),
    registerDeletionHandler: (handler: (target: PredictionDeletionTarget) => Promise<void>) => {
      mocks.deleteTarget = handler
      return () => {
        if (mocks.deleteTarget === handler) mocks.deleteTarget = undefined
      }
    },
  }),
}))
vi.mock('./PredictionModelSummary', () => ({ PredictionModelSummary: () => null }))
vi.mock('./RemotePredictionSettings', () => ({ RemotePredictionSettings: () => null }))
vi.mock('./predictionContextData', () => ({
  loadPredictionContextData: mocks.loadContextData,
  loadPredictionContextFingerprint: mocks.loadContextFingerprint,
  loadPredictionSelectedTargets: mocks.selectedTargets,
  loadPredictionSamplingMeasurements: mocks.samplingMeasurements,
  loadPredictionValidationData: async () => ({
    actual: mocks.actual ? [{ calculation_id: 1, data: mocks.actual }] : [],
    currentSourceFingerprints: new Map([[1, mocks.actualSource]]),
  }),
}))
vi.mock('./usePredictionModels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./usePredictionModels')>()),
  defaultPredictionSetup: Object.freeze({
    calculationIds: Object.freeze([]),
    algorithm: Object.freeze({
      kind: 'knn',
      calculationWeights: Object.freeze({}),
      kMode: 'auto',
      manualK: 1,
      weighting: 'distance',
    }),
    executionId: 'browser-knn',
  }),
  usePredictionModels: () => ({
    forwardOutputs: mocks.forwardOutputs,
    predictInverse: mocks.predictInverse,
  }),
}))
vi.mock('./PredictionPanels', () => ({
  PredictionCalculationPane: ({
    items,
    onOutputChange,
  }: {
    items: readonly {
      actual: { output: CalculationDataOutput | null; status: string }
      calculationId: number
      primary: { output: CalculationDataOutput | null; role: string; status: string }
      repredicted?: { output: CalculationDataOutput | null; status: string }
    }[]
    onOutputChange: (calculationId: number, output: CalculationDataOutput) => void
  }) => (
    <section aria-label="Prediction calculation test pane">
      {items.map((item) => (
        <div
          data-actual={item.actual.output?.data ?? ''}
          data-actual-status={item.actual.status}
          data-primary={item.primary.output?.data ?? ''}
          data-primary-role={item.primary.role}
          data-primary-status={item.primary.status}
          data-repredicted={item.repredicted?.output?.data ?? ''}
          data-repredicted-status={item.repredicted?.status ?? ''}
          data-testid={`calculation-${item.calculationId}`}
          key={item.calculationId}
        />
      ))}
      <button type="button" onClick={() => onOutputChange(1, scalar(20))}>
        Edit Target
      </button>
    </section>
  ),
  PredictionDetailsDialog: ({
    open,
    validationComparisons,
  }: {
    open: boolean
    validationComparisons: readonly unknown[]
  }) => (open ? <div role="dialog" data-validation-count={validationComparisons.length} /> : null),
  PredictionSetupDialog: ({
    calculateMissingDisabled,
    executionSettings,
    onCalculateMissing,
    open,
    applyDisabled,
    onApply,
    onCancel,
    onReload,
  }: {
    calculateMissingDisabled: boolean
    executionSettings: { props: { onUse: (setup: PredictionSetup, direction?: 'forward' | 'inverse') => void } }
    onCalculateMissing: () => void
    open: boolean
    applyDisabled: boolean
    onApply: () => void
    onCancel: () => void
    onReload: () => void
  }) => {
    mocks.calculateMissing = onCalculateMissing
    mocks.applySavedSetup = executionSettings.props.onUse
    return (
      <>
        <button disabled={calculateMissingDisabled} onClick={onCalculateMissing}>
          Calculate missing
        </button>
        {open && (
          <>
            <button disabled={applyDisabled} onClick={onApply}>
              Apply settings
            </button>
            <button onClick={onCancel}>Cancel settings</button>
            <button onClick={onReload}>Reload data</button>
          </>
        )}
      </>
    )
  },
  PredictionVarsPane: ({ onVarsChange }: { onVarsChange: (vars: { x: number }) => void }) => (
    <button type="button" onClick={() => onVarsChange({ x: 2 })}>
      Edit Vars
    </button>
  ),
}))

function scalar(data: number): CalculationDataOutput {
  return { dtype: 'float64', shape: [], data, axes: [] }
}

function predictionResult(direction: 'forward' | 'inverse', value: number) {
  return {
    calculated: { values: { 1: scalar(value) }, errors: {} },
    model: {
      fingerprint: `${direction}-model`,
      profile: {
        direction,
        inputLayouts: direction === 'inverse' ? [{ key: 'calculation:1', dtype: 'float64', shape: [] }] : [],
        knn: {
          inputScales: direction === 'inverse' ? new Float64Array([1]) : new Float64Array(),
          inputBlockWeights: { 'calculation:1': 1 },
        },
      },
    },
    result: {
      constantInputKeysChanged: [],
      extrapolatedInputKeys: [],
      knn: { neighbors: [] },
      output: direction === 'inverse' ? [{ layout: { key: 'x', dtype: 'float64', shape: [] }, values: [3] }] : [],
      queryDiagnostics: [],
    },
  }
}

function TestWorkspace({ deferCandidateEvaluation = false }: { deferCandidateEvaluation?: boolean }) {
  const [active, setActive] = useState(true)
  const [dataReadable, setDataReadable] = useState(true)
  const [experimentId, setExperimentId] = useState(10)
  const [varsContainer, setVarsContainer] = useState<HTMLDivElement | null>(null)
  const [candidate, setCandidate] = useState({ x: 1 })
  const [evaluatedCandidate, setEvaluatedCandidate] = useState({ x: 1 })
  const [command, setCommand] = useState<PredictionWorkspaceCommand | null>(null)
  const onChromeStateChange = useCallback((state: PredictionWorkspaceChromeState) => mocks.chromeState(state), [])
  const workbench = {
    calculationDataActions: { busy: false, cancel: vi.fn(), calculateMeasurement: mocks.calculateMeasurement },
    candidateVars: candidate,
    selectionContext: { experimentId, measurementId: mocks.selectedMeasurementId, calculationId: 1 },
    experiment: { sourceBundle: { files: { 'experiment.tsx': 'export default 1' } } },
    experimentClean: true,
    experimentDocument: {
      draftTaskNames: [],
      materialSnapshot: mocks.predictionOnly ? null : {},
      predictionCandidate: mocks.predictionOnly
        ? { sourceHash: 'prediction-source', variables: candidate, records: [] }
        : undefined,
      geometryPending: mocks.predictionOnly,
      revision: 1,
      status: deferCandidateEvaluation && candidate.x !== evaluatedCandidate.x ? 'Evaluating' : 'Ready',
      successfulRevision: 1,
      variables: deferCandidateEvaluation ? evaluatedCandidate : candidate,
      varsSchema: { x: { min: 0, max: 10, shape: [] } },
    },
    experimentId,
    experimentIsDemo: false,
    experimentManageable: mocks.manageable,
    experimentRecord: null,
    measurementActions: {
      busy: false,
      cancel: vi.fn(),
      detach: vi.fn(),
      saveAndRunCurrentAsync: mocks.saveAndRun,
      runCandidatesAsync: mocks.runCandidates,
      stage: null,
    },
    setCandidateVariables: (vars: { x: number }) => {
      mocks.setCandidate(vars)
      setCandidate(vars)
      return true
    },
  } as unknown as CaeWorkbenchState

  return (
    <>
      {deferCandidateEvaluation ? (
        <button type="button" onClick={() => setEvaluatedCandidate(candidate)}>
          Finish Candidate Evaluation
        </button>
      ) : null}
      <button type="button" onClick={() => setCommand({ id: (command?.id ?? 0) + 1, type: 'validate' })}>
        Validate
      </button>
      <button type="button" onClick={() => setCandidate({ x: 4 })}>
        Change Candidate
      </button>
      <button type="button" onClick={() => setCommand({ id: (command?.id ?? 0) + 1, type: 'sample', sampleCount: 3 })}>
        Sample
      </button>
      <button onClick={() => setCommand({ id: (command?.id ?? 0) + 1, type: 'cancel' })}>Cancel</button>
      <button onClick={() => setActive(false)}>Leave Prediction</button>
      <button onClick={() => setActive(true)}>Return to Prediction</button>
      <button onClick={() => setCommand({ id: (command?.id ?? 0) + 1, type: 'settings' })}>Settings</button>
      <button onClick={() => setDataReadable(false)}>Lose access</button>
      <button onClick={() => setDataReadable(true)}>Regain access</button>
      <button onClick={() => setCommand({ id: (command?.id ?? 0) + 1, type: 'details' })}>Details</button>
      <div ref={setVarsContainer} />
      <button onClick={() => setExperimentId(11)}>Change Experiment</button>
      <button
        onClick={() => {
          mocks.queryScope = 'user:other'
          setCommand({ id: (command?.id ?? 0) + 1, type: 'details' })
        }}
      >
        Change User
      </button>
      <PredictionWorkspace
        active={active}
        authenticated
        dataReadable={dataReadable}
        command={command}
        onChromeStateChange={onChromeStateChange}
        onViewerStateChange={mocks.viewerState}
        onRequestLogin={() => undefined}
        selectedCalculationId={1}
        varsContainer={varsContainer}
        workbench={workbench}
      />
    </>
  )
}

async function renderWorkspace(deferCandidateEvaluation = false, applySettings = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  await act(async () => {
    render(<TestWorkspace deferCandidateEvaluation={deferCandidateEvaluation} />, { wrapper })
  })
  if (applySettings) {
    await screen.findByTestId('calculation-1')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply settings' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.queryScope = 'user:test'
  mocks.selectedMeasurementId = null
  mocks.selectedTargets.mockReset().mockResolvedValue([])
  mocks.samplingMeasurements.mockReset().mockResolvedValue([{ id: 15, vars: { x: 0.25 }, recorded_at: '2026-10-01' }])
  mocks.startSampling
    .mockReset()
    .mockResolvedValue({ existingCenterCount: 1, candidateCount: 10, activeComponentCount: 1 })
  mocks.viewerState.mockReset()
  mocks.chromeState.mockReset()
  mocks.setCandidate.mockReset()
  mocks.workerCreated.mockReset()
  mocks.manageable = true
  mocks.predictionOnly = false
  mocks.calculateMeasurement.mockReset()
  mocks.runCandidates.mockReset()
  mocks.nextSample.mockReset()
  mocks.acceptSample.mockReset()
  mocks.actual = scalar(18)
  mocks.actualSource = 'calculation-source'
  mocks.contextFingerprint = 'before'
  mocks.calculationSource = 'calculation-source'
  mocks.forwardOutputs.mockReset()
  mocks.loadContextData.mockReset()
  mocks.loadContextFingerprint.mockReset()
  mocks.predictInverse.mockReset()
  mocks.saveAndRun.mockReset()
  mocks.saveAndRun.mockImplementation(async () => {
    mocks.contextFingerprint = 'after'
    return { measurementId: 2 }
  })
  mocks.loadContextData.mockImplementation(async ({ experimentId }) => ({
    analysis: { fingerprint: mocks.contextFingerprint, items: [] },
    calculations: [
      {
        id: 1,
        name: 'Result',
        description: null,
        source_code: 'export default 1',
        source_hash: mocks.calculationSource,
        contract_status: 'ready',
        output_layout: { dtype: 'float64', shape: [], axes: [] },
        experiment_record_ids: [],
      },
    ],
    experimentId,
    experimentRecords: [],
    fingerprint: mocks.contextFingerprint,
    measurements: [{ id: 1, vars: { x: 1 }, recorded_at: '2026-09-08T00:00:00Z' }],
  }))
  mocks.loadContextFingerprint.mockImplementation(async () => mocks.contextFingerprint)
})

it.each([false, true])('does not activate Browser from entry or restored settings (%s)', async (restored) => {
  if (restored) persistPredictionSetup('user:test', 10, { ...defaultPredictionSetup, calculationIds: [1] })
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Apply settings' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Reload data' }))
  await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit Vars' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  fireEvent.focus(window)
  await act(async () => undefined)
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  expect(mocks.predictInverse).not.toHaveBeenCalled()
  expect(mocks.workerCreated).not.toHaveBeenCalled()
  expect(mocks.chromeState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'Prediction Settings에서 설정을 적용하세요.',
      canValidate: false,
      canSample: false,
    }),
  )
})

it('keeps Browser active across tab changes and refreshes changed Vars', async () => {
  mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
  await renderWorkspace()
  await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Leave Prediction' }))
  fireEvent.click(screen.getByRole('button', { name: 'Return to Prediction' }))
  await act(async () => undefined)
  expect(mocks.forwardOutputs).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Vars' }))
  await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledTimes(2))
})

it('restores Browser settings without activation after a fresh mount', async () => {
  mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
  await renderWorkspace()
  await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledOnce())
  cleanup()
  mocks.forwardOutputs.mockClear()
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  await act(async () => undefined)
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  expect(mocks.chromeState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'Prediction Settings에서 설정을 적용하세요.',
    }),
  )
})

it('starts the selected Inverse direction only after settings are applied', async () => {
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 20))
  mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  expect(mocks.predictInverse).not.toHaveBeenCalled()
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Apply settings' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledOnce())
  await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledOnce())
})

it.each(['Change Experiment', 'Change User'])(
  'requires reapplication after %s and ignores late prediction',
  async (action) => {
    let finish!: (value: ReturnType<typeof predictionResult>) => void
    mocks.forwardOutputs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await renderWorkspace()
    await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    await act(async () => finish(predictionResult('forward', 10)))
    expect(mocks.forwardOutputs).toHaveBeenCalledOnce()
    expect(mocks.viewerState).toHaveBeenLastCalledWith(null)
    expect(mocks.chromeState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'Prediction Settings에서 설정을 적용하세요.',
        canValidate: false,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply settings' })).toBeEnabled())
    mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 12))
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
    await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledTimes(2))
  },
)

it('reloads changed training inputs before retrying Forward', async () => {
  mocks.forwardOutputs.mockRejectedValueOnce(new PredictionTrainingChangedError()).mockImplementation(async () => {
    expect(mocks.loadContextData).toHaveBeenCalledTimes(2)
    return predictionResult('forward', 12)
  })
  await renderWorkspace()
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '12'))
  expect(mocks.forwardOutputs).toHaveBeenCalledTimes(2)
})

it.each(['inverse', 'surrogate'] as const)(
  'reloads changed %s training inputs while preserving the user Target',
  async (stage) => {
    mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
    mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
    await renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    const operation = stage === 'inverse' ? mocks.predictInverse : mocks.forwardOutputs
    operation.mockRejectedValueOnce(new PredictionTrainingChangedError())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '10'))
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary-role', 'target')
    expect(mocks.predictInverse).toHaveBeenCalledTimes(2)
  },
)

describe('Prediction Save & Run snapshot display', () => {
  it('prepares three samples through one Batch action and refreshes context once after completion', async () => {
    mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
    mocks.nextSample.mockImplementation(async (_session, _fingerprint, attempt) => [
      { layout: { key: 'x', dtype: 'float64', shape: [] }, values: [attempt] },
    ])
    const vars: unknown[] = []
    mocks.runCandidates.mockImplementation(
      async (candidates: BrowserBatchCandidates, onProgress: (progress: CandidateBatchProgress) => void) => {
        for (let attempt = 1; attempt <= candidates.count; attempt += 1) {
          expect(mocks.acceptSample).toHaveBeenCalledTimes(attempt - 1)
          vars.push(await candidates.next(attempt, new AbortController().signal))
          await candidates.accepted(attempt)
          expect(mocks.loadContextData).toHaveBeenCalledOnce()
        }
        mocks.contextFingerprint = 'after'
        onProgress({
          batchId: 'batch',
          total: 3,
          succeeded: 3,
          failed: 0,
          cancelled: 0,
          calculationFailed: 0,
          calculated: 3,
        })
      },
    )
    await renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Sample' }))
    await waitFor(() => expect(mocks.runCandidates).toHaveBeenCalledOnce())
    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    expect(vars).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
    expect(mocks.saveAndRun).not.toHaveBeenCalled()
    expect(mocks.acceptSample).toHaveBeenCalledTimes(3)
  })
  it.each(['layout', 'invalid', 'source', 'missing'] as const)(
    'handles %s Actual independently of comparison compatibility',
    async (scenario) => {
      mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
      if (scenario === 'layout')
        mocks.actual = { dtype: 'float64', shape: [2], axes: [{ name: 'time', ticks: [0, 2] }], data: [12, 22] }
      if (scenario === 'invalid') mocks.actual = { ...scalar(18), data: Number.NaN }
      if (scenario === 'source') mocks.actualSource = 'changed-source'
      if (scenario === 'missing') mocks.actual = null
      await renderWorkspace()
      await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
      await waitFor(() => expect(mocks.saveAndRun).toHaveBeenCalled())
      await waitFor(() =>
        expect(screen.getByTestId('calculation-1')).toHaveAttribute(
          'data-actual-status',
          scenario === 'layout' ? 'ready' : scenario === 'invalid' ? 'incompatible' : 'unavailable',
        ),
      )
      expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', scenario === 'layout' ? '12,22' : '')
    },
  )
  it('keeps the frozen forward prediction and Actual after the automatic data reload', async () => {
    mocks.forwardOutputs
      .mockResolvedValueOnce(predictionResult('forward', 10))
      .mockResolvedValue(predictionResult('forward', 99))
    await renderWorkspace()

    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    await waitFor(() => {
      const item = screen.getByTestId('calculation-1')
      expect(item).toHaveAttribute('data-primary', '10')
      expect(item).toHaveAttribute('data-primary-status', 'ready')
      expect(item).toHaveAttribute('data-actual', '18')
      expect(item).toHaveAttribute('data-actual-status', 'ready')
    })
    fireEvent.focus(window)
    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10')

    fireEvent.click(screen.getByRole('button', { name: 'Change Candidate' }))
    await waitFor(() =>
      expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual-status', 'unavailable'),
    )
  })

  it('keeps Target, Re-predicted, and Actual after inverse retraining changes the Candidate', async () => {
    mocks.forwardOutputs
      .mockResolvedValueOnce(predictionResult('forward', 10))
      .mockResolvedValueOnce(predictionResult('forward', 19))
      .mockResolvedValue(predictionResult('forward', 77))
    mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
    await renderWorkspace()

    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19'))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    await waitFor(() => {
      const item = screen.getByTestId('calculation-1')
      expect(item).toHaveAttribute('data-primary-role', 'target')
      expect(item).toHaveAttribute('data-primary', '20')
      expect(item).toHaveAttribute('data-repredicted', '19')
      expect(item).toHaveAttribute('data-repredicted-status', 'ready')
      expect(item).toHaveAttribute('data-actual', '18')
      expect(item).toHaveAttribute('data-actual-status', 'ready')
    })
    fireEvent.focus(window)
    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() =>
      expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual-status', 'unavailable'),
    )
  })

  it('retains inverse Re-predicted even when its dtype differs from Target', async () => {
    const repredicted = predictionResult('forward', 19)
    repredicted.calculated.values[1] = { ...scalar(19), dtype: 'float32' }
    mocks.forwardOutputs.mockResolvedValueOnce(predictionResult('forward', 10)).mockResolvedValue(repredicted)
    mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
    await renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19'))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted-status', 'ready')
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19')
  })

  it('waits for the inverse candidate Geometry before restoring its Forward tensors', async () => {
    mocks.forwardOutputs
      .mockResolvedValueOnce(predictionResult('forward', 10))
      .mockResolvedValue(predictionResult('forward', 19))
    mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
    await renderWorkspace(true)
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledOnce())
    expect(mocks.forwardOutputs).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Finish Candidate Evaluation' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19'))
    expect(mocks.forwardOutputs).toHaveBeenLastCalledWith({ x: 3 }, expect.any(Number), expect.any(Function))
  })

  it('clears the snapshot when an automatic reload finds a changed Calculation contract', async () => {
    mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
    mocks.saveAndRun.mockImplementation(async () => {
      mocks.contextFingerprint = 'after'
      mocks.calculationSource = 'changed-source'
      return { measurementId: 2 }
    })
    await renderWorkspace()

    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
    fireEvent.focus(window)

    await waitFor(() => expect(mocks.loadContextData).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual-status', 'unavailable'),
    )
  })
})

it('clears validation, the Viewer and the open details dialog when data access is lost', async () => {
  mocks.forwardOutputs.mockImplementation(async (_vars, _transaction, publish) => {
    publish(recordedPreview)
    return predictionResult('forward', 10)
  })
  await renderWorkspace()
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByRole('dialog')).toHaveAttribute('data-validation-count', '1')

  fireEvent.click(screen.getByRole('button', { name: 'Lose access' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mocks.viewerState).toHaveBeenLastCalledWith(null)

  // Keep the next load pending so the old validation cannot be cleared by a successful reload.
  mocks.loadContextData.mockImplementation(() => new Promise(() => {}))
  fireEvent.click(screen.getByRole('button', { name: 'Regain access' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByRole('dialog')).toHaveAttribute('data-validation-count', '0')
})

it('blocks validation, sampling and missing-data writes without persistent Experiment access', async () => {
  const denied = vi.spyOn(toast, 'error').mockImplementation(() => 'denied')
  mocks.manageable = false
  mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
  await renderWorkspace()
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
  expect(screen.getByRole('button', { name: 'Calculate missing' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sample' }))
  expect(denied).toHaveBeenCalledTimes(2)
  for (const call of denied.mock.calls) expect(call[0]).toBe('이 Experiment의 데이터를 변경할 권한이 없습니다.')
  await act(async () => mocks.calculateMissing())
  expect(mocks.saveAndRun).not.toHaveBeenCalled()
  expect(mocks.runCandidates).not.toHaveBeenCalled()
  expect(mocks.calculateMeasurement).not.toHaveBeenCalled()
})

const recordedPreview: PredictionRecordedPreview = {
  modelFingerprint: 'model-before-calculation',
  recorded: {},
  rules: [],
  resultContracts: {},
}

it('publishes RecordedData before Calculation, rejects old Vars callbacks, and retains it after Calculation fails', async () => {
  const pending: {
    vars: { x: number }
    publish: (preview: PredictionRecordedPreview) => void
    reject: (error: Error) => void
  }[] = []
  mocks.forwardOutputs.mockImplementation(
    (vars, _transaction, publish) =>
      new Promise((_resolve, reject) => {
        pending.push({ vars, publish, reject })
      }),
  )
  await renderWorkspace(true)
  await waitFor(() => expect(pending).toHaveLength(1))
  await act(async () => pending[0].publish(recordedPreview))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: recordedPreview }))
  fireEvent.click(screen.getByRole('button', { name: 'Change Candidate' }))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(null)
  await act(async () => pending[0].publish(recordedPreview))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: 'Finish Candidate Evaluation' }))
  await waitFor(() => expect(pending).toHaveLength(2))
  const next = { ...recordedPreview, modelFingerprint: 'next-model' }
  await act(async () => pending[1].publish(next))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: next }))
  await act(async () => pending[0].publish(recordedPreview))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: next }))
  await act(async () => pending[1].reject(new Error('Calculation failed')))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: next }))
})

it.each(['Cancel', 'Leave Prediction', 'Change Experiment'])(
  'discards pending RecordedData after %s',
  async (action) => {
    mocks.forwardOutputs.mockImplementation(() => new Promise(() => {}))
    await renderWorkspace()
    await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalled())
    const publish = mocks.forwardOutputs.mock.calls[0][2]
    fireEvent.click(screen.getByRole('button', { name: action }))
    await act(async () => publish(recordedPreview))
    expect(mocks.viewerState).toHaveBeenLastCalledWith(null)
  },
)

it.each(['immediate', 'delayed'] as const)(
  'waits for explicit application after an %s initial freshness check',
  async (timing) => {
    let finishCheck!: (fingerprint: string) => void
    const checked = new Promise<string>((resolve) => {
      finishCheck = resolve
    })
    if (timing === 'immediate') finishCheck('before')
    mocks.loadContextFingerprint.mockReturnValue(checked)
    mocks.forwardOutputs.mockImplementation(() => new Promise(() => {}))

    await renderWorkspace(false, false)
    await waitFor(() => expect(mocks.loadContextFingerprint).toHaveBeenCalled())
    if (timing === 'delayed') {
      expect(mocks.forwardOutputs).not.toHaveBeenCalled()
      await act(async () => finishCheck('before'))
    }
    expect(mocks.forwardOutputs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply settings' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }))
    await waitFor(() => expect(mocks.forwardOutputs).toHaveBeenCalledOnce())
    await act(async () => undefined)
    expect(mocks.forwardOutputs).toHaveBeenCalledOnce()
  },
)

it('publishes Inverse surrogate BoxGrid while preserving the user Target', async () => {
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 20))
  mocks.forwardOutputs.mockImplementation(async (_vars, _transaction, publish) => {
    publish(recordedPreview)
    return predictionResult('forward', 10)
  })
  await renderWorkspace()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '10'))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: recordedPreview }))
})

it('predicts and enables Save & Run from metadata while Geometry and material snapshots are absent', async () => {
  mocks.predictionOnly = true
  mocks.forwardOutputs.mockImplementation(async (_vars, _transaction, publish) => {
    publish(recordedPreview)
    return predictionResult('forward', 10)
  })
  await renderWorkspace()
  await waitFor(() =>
    expect(mocks.viewerState).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceHash: 'prediction-source', preview: recordedPreview }),
    ),
  )
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: true })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(mocks.saveAndRun).toHaveBeenCalledTimes(1))
})

function inverseOnlySetup(): PredictionSetup {
  return {
    ...defaultPredictionSetup,
    executionId: 'remote-knn',
    calculationIds: [1],
    routes: {
      inverse: {
        launcherId: '10000000-0000-4000-8000-000000000001',
        storageId: '10000000-0000-4000-8000-000000000002',
      },
    },
    models: {
      inverse: {
        modelId: '20000000-0000-4000-8000-000000000001',
        modelRevision: 3,
        datasetId: '30000000-0000-4000-8000-000000000001',
        datasetRevision: 2,
        direction: 'inverse',
        fingerprint: 'saved-inverse',
        contract: { experimentId: 10, varsSchemaFingerprint: 'vars', records: {}, calculations: { '1': 'contract' } },
      },
    },
  }
}

it('preserves the Target and actual comparison when deletion releases this Inverse copy and blocks reuse', async () => {
  const setup = inverseOnlySetup()
  persistPredictionSetup('user:test', 10, setup)
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  const release = vi.spyOn(PredictionRuntimeController.prototype, 'releaseLoadedModels')
  await renderWorkspace(false, false)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Target' }))
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: true })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
  await act(async () =>
    mocks.deleteTarget!({
      modelId: setup.models!.inverse!.modelId,
      revision: 3,
      storageId: setup.routes!.inverse!.storageId,
    }),
  )
  expect(release).toHaveBeenCalledWith(['inverse'])
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18')
  expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: false }))
  mocks.predictInverse.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  expect(mocks.predictInverse).not.toHaveBeenCalled()
  release.mockRestore()
})

it('uses explicit Targets and validates Inverse without loading or predicting Forward', async () => {
  persistPredictionSetup('user:test', 10, inverseOnlySetup())
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(
      expect.objectContaining({ canValidate: true, direction: 'inverse' }),
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted-status', 'unavailable')
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('loads current Recorded Measurement centers only when sampling with a saved model', async () => {
  persistPredictionSetup('user:test', 10, inverseOnlySetup())
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  expect(mocks.samplingMeasurements).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canSample: true, canValidate: true })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sample' }))
  await waitFor(() => expect(mocks.startSampling).toHaveBeenCalledOnce())
  expect(mocks.samplingMeasurements).toHaveBeenCalledWith(expect.any(QueryClient), 'user:test', 10)
  expect(mocks.startSampling).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      centers: [[expect.objectContaining({ layout: expect.objectContaining({ key: 'x' }), values: [0.25] })]],
    }),
  )
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
})

it('initializes missing Inverse Targets from the selected actual values only', async () => {
  persistPredictionSetup('user:test', 10, inverseOnlySetup())
  mocks.selectedMeasurementId = 9
  mocks.selectedTargets.mockResolvedValue([{ id: 80, calculation_id: 1, measurement_id: 9, data: scalar(12) }])
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalled())
  expect(mocks.selectedTargets).toHaveBeenCalledWith(10, 9, [1], expect.any(AbortSignal))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '12')
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
})

it('does not overwrite an explicit Target when selected actual values arrive late', async () => {
  persistPredictionSetup('user:test', 10, inverseOnlySetup())
  mocks.selectedMeasurementId = 9
  let complete!: (value: unknown) => void
  mocks.selectedTargets.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await waitFor(() => expect(mocks.selectedTargets).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledOnce())
  await act(async () => complete([{ id: 80, calculation_id: 1, measurement_id: 9, data: scalar(12) }]))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
  expect(mocks.predictInverse).toHaveBeenCalledOnce()
})

it('preserves Target and completed Actual comparison when only the execution copy changes', async () => {
  const setup = inverseOnlySetup()
  persistPredictionSetup('user:test', 10, setup)
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: true })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
  await act(async () =>
    mocks.applySavedSetup({
      ...setup,
      routes: {
        inverse: {
          launcherId: '40000000-0000-4000-8000-000000000001',
          storageId: '40000000-0000-4000-8000-000000000002',
        },
      },
    }),
  )
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18')
  expect(mocks.forwardOutputs).not.toHaveBeenCalled()
  expect(mocks.predictInverse).toHaveBeenCalledOnce()
})

it('preserves a completed predicted Viewer when only its execution route changes', async () => {
  const inverse = inverseOnlySetup()
  const setup: PredictionSetup = {
    ...inverse,
    models: { forward: { ...inverse.models!.inverse!, direction: 'forward' } },
    routes: { forward: inverse.routes!.inverse },
  }
  persistPredictionSetup('user:test', 10, setup)
  mocks.forwardOutputs.mockImplementation(async (_vars, _transaction, publish) => {
    publish(recordedPreview)
    return predictionResult('forward', 10)
  })
  await renderWorkspace(false, false)
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: recordedPreview }))
  await act(async () =>
    mocks.applySavedSetup({
      ...setup,
      routes: {
        forward: {
          launcherId: '40000000-0000-4000-8000-000000000001',
          storageId: '40000000-0000-4000-8000-000000000002',
        },
      },
    }),
  )
  expect(mocks.viewerState).toHaveBeenLastCalledWith(expect.objectContaining({ preview: recordedPreview }))
  expect(mocks.forwardOutputs).toHaveBeenCalledOnce()
})

it('keeps a committed Save & Run busy and accepts Actual after a route-only change', async () => {
  const setup = inverseOnlySetup()
  persistPredictionSetup('user:test', 10, setup)
  let complete!: (value: { measurementId: number }) => void
  mocks.saveAndRun.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() =>
    expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: true })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => expect(mocks.saveAndRun).toHaveBeenCalledOnce())
  await act(async () =>
    mocks.applySavedSetup({
      ...setup,
      routes: {
        inverse: {
          launcherId: '40000000-0000-4000-8000-000000000001',
          storageId: '40000000-0000-4000-8000-000000000002',
        },
      },
    }),
  )
  expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true, canValidate: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  expect(mocks.saveAndRun).toHaveBeenCalledOnce()
  await act(async () => complete({ measurementId: 2 }))
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
})

it('restarts interrupted Inverse on a new route and discards the old late candidate', async () => {
  const setup = inverseOnlySetup()
  persistPredictionSetup('user:test', 10, setup)
  let complete!: (value: ReturnType<typeof predictionResult>) => void
  mocks.predictInverse
    .mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    .mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await screen.findByTestId('calculation-1')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledOnce())
  await act(async () =>
    mocks.applySavedSetup({
      ...setup,
      routes: {
        inverse: {
          launcherId: '40000000-0000-4000-8000-000000000001',
          storageId: '40000000-0000-4000-8000-000000000002',
        },
      },
    }),
  )
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledTimes(2))
  expect(mocks.setCandidate).toHaveBeenCalledOnce()
  await act(async () => complete(predictionResult('inverse', 0)))
  expect(mocks.setCandidate).toHaveBeenCalledOnce()
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '20')
})

it('using the selected Inverse model switches direction and retains a compatible existing Target', async () => {
  const inverse = inverseOnlySetup()
  const setup: PredictionSetup = {
    ...inverse,
    models: {
      ...inverse.models,
      forward: {
        ...inverse.models!.inverse!,
        modelId: '20000000-0000-4000-8000-000000000002',
        direction: 'forward',
      },
    },
    routes: { ...inverse.routes, forward: inverse.routes!.inverse },
  }
  persistPredictionSetup('user:test', 10, setup)
  mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
  mocks.predictInverse.mockResolvedValue(predictionResult('inverse', 0))
  await renderWorkspace(false, false)
  await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
  await act(async () => mocks.applySavedSetup(setup, 'inverse'))
  await waitFor(() => expect(mocks.predictInverse).toHaveBeenCalledOnce())
  expect(mocks.chromeState).toHaveBeenLastCalledWith(expect.objectContaining({ direction: 'inverse' }))
  expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10')
  expect(mocks.selectedTargets).not.toHaveBeenCalled()
})
