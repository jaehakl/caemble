import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useState, type PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalculationDataOutput } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { BrowserBatchCandidates } from '@/features/measurement/buildBatchArtifact'
import type { CandidateBatchProgress } from '@/features/measurement/useCaeMeasurementActions'
import { PredictionWorkspace, type PredictionWorkspaceCommand } from './PredictionWorkspace'

const mocks = vi.hoisted(() => ({
  calculationSource: 'calculation-source',
  contextFingerprint: 'before',
  forwardOutputs: vi.fn(),
  loadContextData: vi.fn(),
  loadContextFingerprint: vi.fn(),
  predictInverse: vi.fn(),
  saveAndRun: vi.fn(),
  runCandidates: vi.fn(),
  nextSample: vi.fn(),
  acceptSample: vi.fn(),
  actual: null as CalculationDataOutput | null,
  actualSource: 'calculation-source',
}))

vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'user:test' }))
vi.mock('@/lib/calculation', () => ({ calculationSourceHash: async () => 'calculation-source' }))
vi.mock('../experiment/queryOptions', () => ({
  availableExperimentsQueryOptions: () => ({
    queryKey: ['prediction-test-experiments'],
    queryFn: async () => ({ demos: [], mine: [] }),
  }),
}))
vi.mock('./client', () => ({
  PredictionWorkerClient: class {
    epoch = 0
    cancelPending() {
      return false
    }
    dispose() {}
    reset() {}
    async startSampling() {
      return { existingCenterCount: 1, candidateCount: 10, activeComponentCount: 1 }
    }
    nextSample = mocks.nextSample
    acceptSample = mocks.acceptSample
    async dropSampling() {}
  },
  PredictionWorkerRestartError: class extends Error {},
}))
vi.mock('./diagnostics', () => ({ emitPredictionCohortDiagnostics: () => undefined }))
vi.mock('./predictionContextData', () => ({
  loadPredictionContextData: mocks.loadContextData,
  loadPredictionContextFingerprint: mocks.loadContextFingerprint,
  loadPredictionValidationData: async () => ({
    actual: mocks.actual ? [{ calculation_id: 1, data: mocks.actual }] : [],
    currentSourceFingerprints: new Map([[1, mocks.actualSource]]),
  }),
}))
vi.mock('./usePredictionModels', () => ({
  defaultPredictionSetup: Object.freeze({
    calculationIds: Object.freeze([]),
    calculationWeights: Object.freeze({}),
    kMode: 'auto',
    manualK: 1,
    weighting: 'distance',
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
  PredictionDetailsDialog: () => null,
  PredictionSetupDialog: () => null,
  PredictionVarsPane: ({ onVariableChange }: { onVariableChange: (key: string, value: number) => void }) => (
    <button type="button" onClick={() => onVariableChange('x', 2)}>
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
        inputScales: direction === 'inverse' ? new Float64Array([1]) : new Float64Array(),
      },
    },
    result: {
      constantInputKeysChanged: [],
      extrapolatedInputKeys: [],
      neighbors: [],
      output: direction === 'inverse' ? [{ layout: { key: 'x', dtype: 'float64', shape: [] }, values: [3] }] : [],
      queryDiagnostics: [],
    },
  }
}

function TestWorkspace() {
  const [candidate, setCandidate] = useState({ x: 1 })
  const [command, setCommand] = useState<PredictionWorkspaceCommand | null>(null)
  const onChromeStateChange = useCallback(() => undefined, [])
  const workbench = {
    calculationDataActions: { busy: false, cancel: vi.fn(), calculateMeasurement: vi.fn() },
    candidateVars: candidate,
    experiment: { sourceBundle: { files: { 'experiment.tsx': 'export default 1' } } },
    experimentClean: true,
    experimentDocument: {
      draftTaskNames: [],
      materialSnapshot: {},
      revision: 1,
      status: 'Ready',
      successfulRevision: 1,
      variables: candidate,
      varsSchema: { x: { min: 0, max: 10, shape: [] } },
    },
    experimentId: 10,
    experimentIsDemo: false,
    experimentManageable: true,
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
      setCandidate(vars)
      return true
    },
  } as unknown as CaeWorkbenchState

  return (
    <>
      <button type="button" onClick={() => setCommand({ id: Date.now(), type: 'validate' })}>
        Validate
      </button>
      <button type="button" onClick={() => setCandidate({ x: 4 })}>
        Change Candidate
      </button>
      <button type="button" onClick={() => setCommand({ id: Date.now(), type: 'sample', sampleCount: 3 })}>
        Sample
      </button>
      <PredictionWorkspace
        active
        authenticated
        dataReadable
        command={command}
        onChromeStateChange={onChromeStateChange}
        onExperimentChange={() => undefined}
        onRequestLogin={() => undefined}
        selectedCalculationId={1}
        varsContainer={null}
        workbench={workbench}
      />
    </>
  )
}

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return render(<TestWorkspace />, { wrapper })
}

beforeEach(() => {
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
  mocks.loadContextData.mockImplementation(async () => ({
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
    experimentId: 10,
    experimentRecords: [],
    fingerprint: mocks.contextFingerprint,
    measurements: [{ id: 1, vars: { x: 1 }, recorded_at: '2026-09-08T00:00:00Z' }],
  }))
  mocks.loadContextFingerprint.mockImplementation(async () => mocks.contextFingerprint)
})

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
    renderWorkspace()
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
      renderWorkspace()
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
    renderWorkspace()

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
    renderWorkspace()

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
    renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-primary', '10'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Target' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19'))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-actual', '18'))
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted-status', 'ready')
    expect(screen.getByTestId('calculation-1')).toHaveAttribute('data-repredicted', '19')
  })

  it('clears the snapshot when an automatic reload finds a changed Calculation contract', async () => {
    mocks.forwardOutputs.mockResolvedValue(predictionResult('forward', 10))
    mocks.saveAndRun.mockImplementation(async () => {
      mocks.contextFingerprint = 'after'
      mocks.calculationSource = 'changed-source'
      return { measurementId: 2 }
    })
    renderWorkspace()

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
