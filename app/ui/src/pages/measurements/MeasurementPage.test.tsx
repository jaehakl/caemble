// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CurrentCadSelectionProvider } from '@/features/viewer/current-cad-selection'
import { createExperimentSourceBundle } from '@/lib/cad'
import { MeasurementPage } from './MeasurementPage'

const apiMocks = vi.hoisted(() => ({
  experimentList: vi.fn(),
  measurementContext: vi.fn(),
  measurementDelete: vi.fn(),
  measurementList: vi.fn(),
  measurementSave: vi.fn(),
  recordedDataList: vi.fn(),
  sampleDelete: vi.fn(),
  sampleList: vi.fn(),
  sampleUpsert: vi.fn(),
  setupDelete: vi.fn(),
  setupList: vi.fn(),
  setupUpsert: vi.fn(),
  structureList: vi.fn(),
}))
const cadViewerSpy = vi.hoisted(() => vi.fn())
const solverMocks = vi.hoisted(() => ({
  autoComplete: false,
  cancel: vi.fn(),
  failRunNumbers: [] as number[],
  rejectRunAttempts: 0,
  run: vi.fn(),
  runCount: 0,
  staleSuccessBeforeRunNumbers: [] as number[],
}))
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const workspaceSpy = vi.hoisted(() => vi.fn())

function persistedInlineTensor(value: unknown) {
  return {
    tensorEncodingVersion: 1,
    shape: [],
    storage: { kind: 'inline', value },
  }
}

const experimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ varsSchema: {}, recordedData: {} })`,
  'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
  'tasks/electric.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'dc-current-density', version: '0.0.0' }, lengthUnit: 'm', geometry: () => null, config: () => ({}) })`,
})

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-1', roles: ['user'] },
  }),
}))

vi.mock('@/api', () => ({
  getListRequest: (scope = 'visible', selected_ids = []) => ({
    scope,
    offset: 0,
    limit: 24,
    selected_ids,
    search_text: null,
    text_filter: {},
    filter: {},
    sort: ['updated_at', 'desc'],
  }),
  dbTables: {
    Structure: { listRows: apiMocks.structureList },
    Experiment: { listRows: apiMocks.experimentList },
    Sample: { deleteRows: apiMocks.sampleDelete, listRows: apiMocks.sampleList, upsertRow: apiMocks.sampleUpsert },
    Setup: { deleteRows: apiMocks.setupDelete, listRows: apiMocks.setupList, upsertRow: apiMocks.setupUpsert },
    Measurement: {
      deleteRows: apiMocks.measurementDelete,
      listRows: apiMocks.measurementList,
      listContext: apiMocks.measurementContext,
      save: apiMocks.measurementSave,
    },
    RecordedData: { listRows: apiMocks.recordedDataList },
  },
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

vi.mock('@/features/viewer/persistence/resolveMaterials', () => ({
  resolveDocumentMaterials: vi.fn(async () => ({
    materialParameters: { schemaVersion: 1, materials: {} },
    warnings: [],
  })),
}))

const documentController = {
  diagnostics: [],
  error: null,
  evaluationTimeoutMs: 3000,
  handleRenderEnd: vi.fn(),
  handleRenderError: vi.fn(),
  handleRenderStart: vi.fn(),
  handleReroll: vi.fn(),
  handleSourceChange: vi.fn(),
  materialParameters: { schemaVersion: 1, materials: {} },
  materialWarnings: [],
  readOnly: false,
  revision: 1,
  runIsBusy: false,
  scene: null,
  sceneHash: null,
  setEvaluationTimeoutMs: vi.fn(),
  sourceReadOnly: false,
  status: 'Ready',
  successfulRevision: 1,
  variables: {},
  varsSchema: null,
}

vi.mock('@/features/viewer/workspace/useCadWorkspace', async () => {
  const { useCallback, useEffect, useMemo, useRef, useState } = await import('react')
  return {
    useCadWorkspace: (...args: unknown[]) => {
      workspaceSpy(...args)
      const structureVars = args[4] as Record<string, unknown> | undefined
      const experimentVars = args[5] as Record<string, unknown> | undefined
      const [structureRevision, setStructureRevision] = useState(1)
      const [experimentRevision, setExperimentRevision] = useState(1)
      const [recordedData, setRecordedData] = useState<Record<string, unknown> | null>(null)
      const previousStructureVars = useRef(structureVars)
      const [process, setProcess] = useState({
        runId: null as string | null,
        status: 'idle',
        engine: null as { name: string; version: string } | null,
        stage: null as string | null,
        error: null as string | null,
        startedAt: null as number | null,
        finishedAt: null as number | null,
      })
      const handleStructureReroll = useCallback(() => {
        documentController.handleReroll()
        setStructureRevision((current) => current + 1)
      }, [])
      const handleExperimentReroll = useCallback(() => {
        documentController.handleReroll()
        setExperimentRevision((current) => current + 1)
      }, [])
      useEffect(() => {
        if (previousStructureVars.current === structureVars) return
        previousStructureVars.current = structureVars
        setStructureRevision((current) => current + 1)
      }, [structureVars])
      const run = useCallback(() => {
        solverMocks.run(structureVars)
        if (solverMocks.rejectRunAttempts > 0) {
          solverMocks.rejectRunAttempts -= 1
          queueMicrotask(() => setStructureRevision((current) => current + 1))
          return null
        }
        solverMocks.runCount += 1
        const runNumber = solverMocks.runCount
        const runId = `run-${runNumber}`
        setProcess({
          runId,
          status: 'preparing',
          engine: { name: 'experiment-program', version: '1' },
          stage: 'startup',
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
        })
        if (!solverMocks.autoComplete) return runId
        if (solverMocks.staleSuccessBeforeRunNumbers.includes(runNumber)) {
          setRecordedData({ Current: { value: 999 } })
          setProcess({
            runId: 'previous-run',
            status: 'succeeded',
            engine: { name: 'experiment-program', version: '1' },
            stage: null,
            error: null,
            startedAt: Date.now(),
            finishedAt: Date.now(),
          })
          setTimeout(() => {
            setRecordedData({ Current: { value: runNumber } })
            setProcess({
              runId,
              status: 'succeeded',
              engine: { name: 'experiment-program', version: '1' },
              stage: null,
              error: null,
              startedAt: Date.now(),
              finishedAt: Date.now(),
            })
          }, 0)
          return runId
        }
        queueMicrotask(() => {
          if (solverMocks.failRunNumbers.includes(runNumber)) {
            setProcess({
              runId: `run-${runNumber}`,
              status: 'failed',
              engine: { name: 'experiment-program', version: '1' },
              stage: null,
              error: `run ${runNumber} failed`,
              startedAt: Date.now(),
              finishedAt: Date.now(),
            })
            return
          }
          setRecordedData({ Current: { value: runNumber } })
          setProcess({
            runId: `run-${runNumber}`,
            status: 'succeeded',
            engine: { name: 'experiment-program', version: '1' },
            stage: null,
            error: null,
            startedAt: Date.now(),
            finishedAt: Date.now(),
          })
        })
        return runId
      }, [structureVars])
      const cancel = useCallback(() => {
        solverMocks.cancel()
        setProcess((current) => ({
          ...current,
          status: 'cancelled',
          finishedAt: Date.now(),
        }))
      }, [])
      return {
        structureDocument: {
          ...documentController,
          documentType: 'structure',
          handleReroll: handleStructureReroll,
          revision: structureRevision,
          successfulRevision: structureRevision,
          variables: useMemo(
            () => structureVars ?? { generatedRevision: structureRevision },
            [structureRevision, structureVars],
          ),
        },
        experimentDocument: {
          ...documentController,
          documentType: 'experiment',
          handleReroll: handleExperimentReroll,
          revision: experimentRevision,
          successfulRevision: experimentRevision,
          variables: experimentVars ?? {},
          simulationProgram: {
            formatVersion: 4,
            simulationApiVersion: 2,
            pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
            tasks: {
              electric: {
                kernel: { name: 'dc-current-density', version: '0.0.0' },
                config: {},
              },
            },
            recordedData: {
              Current: {
                dtype: 'float64',
                quantityKind: 'electromagnetism.ElectricCurrent',
                unit: 'A',
                tensorOrder: 0,
              },
            },
          },
        },
        simulation: {
          canRun: process.status !== 'preparing' && process.status !== 'running',
          cancel,
          process,
          recordedData,
          run,
          stale: false,
        },
      }
    },
  }
})

vi.mock('@/features/viewer/viewer/CadViewer', () => ({
  default: (props: unknown) => {
    cadViewerSpy(props)
    return <div data-testid="cad-viewer" />
  },
}))

function renderPage(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      { path: '/measurements', Component: MeasurementPage },
      { path: '/viewer', Component: MeasurementPage },
      { path: '/structures', element: <div>Structure manager</div> },
      { path: '/experiments', element: <div>Experiment manager</div> },
      { path: '/analysis', element: <div>Analysis workspace</div> },
    ],
    { initialEntries: [initialEntry] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <CurrentCadSelectionProvider>
        <RouterProvider router={router} />
      </CurrentCadSelectionProvider>
    </QueryClientProvider>,
  )
  return router
}

function mockSelectedMeasurement() {
  apiMocks.measurementList.mockResolvedValue({
    total: 1,
    items: [{ id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' }],
  })
  apiMocks.sampleList.mockResolvedValue({
    total: 1,
    items: [{ id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} }],
  })
  apiMocks.setupList.mockResolvedValue({
    total: 1,
    items: [{ id: 20, experiment_id: 2, vars: { voltage: 5 }, material_parameters: {} }],
  })
  apiMocks.structureList.mockResolvedValue({
    total: 1,
    items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
  })
  apiMocks.experimentList.mockResolvedValue({
    total: 1,
    items: [{ id: 2, name: 'DC experiment', source_bundle: experimentSourceBundle }],
  })
  apiMocks.measurementContext.mockResolvedValue({
    total: 1,
    items: [{ id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' }],
  })
  apiMocks.recordedDataList.mockResolvedValue({
    total: 1,
    items: [
      {
        id: 40,
        measurement_id: 30,
        name: 'Current',
        quantity_kind: 'ElectricCurrent',
        tensor_order: 0,
        dtype: 'float64',
        data: { value: 2.5 },
      },
    ],
  })
  apiMocks.sampleDelete.mockResolvedValue(undefined)
  apiMocks.setupDelete.mockResolvedValue(undefined)
  apiMocks.measurementDelete.mockResolvedValue(undefined)
}

function mockMeasurementCombinations() {
  const samples = [
    { id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} },
    { id: 11, structure_id: 1, vars: { width: 4 }, material_parameters: {} },
  ]
  const setups = [
    { id: 20, experiment_id: 2, vars: { voltage: 5 }, material_parameters: {} },
    { id: 21, experiment_id: 2, vars: { voltage: 6 }, material_parameters: {} },
    { id: 22, experiment_id: 2, vars: { voltage: 7 }, material_parameters: {} },
  ]
  const measurements = [
    { id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' },
    { id: 31, sample_id: 11, setup_id: 20, updated_at: '2026-07-23T00:01:00Z' },
    { id: 32, sample_id: 11, setup_id: 21, updated_at: '2026-07-23T00:02:00Z' },
  ]
  apiMocks.sampleList.mockImplementation(async (request: { selected_ids?: number[] }) => ({
    total: samples.length,
    items: request.selected_ids?.length
      ? samples.filter((sample) => request.selected_ids?.includes(sample.id))
      : samples,
  }))
  apiMocks.setupList.mockImplementation(async (request: { selected_ids?: number[] }) => ({
    total: setups.length,
    items: request.selected_ids?.length ? setups.filter((setup) => request.selected_ids?.includes(setup.id)) : setups,
  }))
  apiMocks.measurementList.mockImplementation(async (request: { selected_ids?: number[] }) => ({
    total: measurements.length,
    items: request.selected_ids?.length
      ? measurements.filter((measurement) => request.selected_ids?.includes(measurement.id))
      : measurements,
  }))
  apiMocks.structureList.mockResolvedValue({
    total: 1,
    items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
  })
  apiMocks.experimentList.mockResolvedValue({
    total: 1,
    items: [{ id: 2, name: 'DC experiment', source_bundle: experimentSourceBundle }],
  })
  apiMocks.measurementContext.mockResolvedValue({
    total: measurements.length,
    items: measurements,
  })
  apiMocks.recordedDataList.mockImplementation(async (request: { filter?: { measurement_id?: number[] } }) => {
    const measurementId = request.filter?.measurement_id?.[0]
    return {
      total: measurementId ? 1 : 0,
      items: measurementId
        ? [
            {
              id: measurementId + 100,
              measurement_id: measurementId,
              name: 'Current',
              quantity_kind: 'ElectricCurrent',
              tensor_order: 0,
              dtype: 'float64',
              data: { value: measurementId },
            },
          ]
        : [],
    }
  })
}

function mockRunWorkflow(
  initialSamples: Array<{
    id: number
    material_parameters: Record<string, unknown>
    structure_id: number
    vars: Record<string, unknown>
  }>,
  initialMeasurements: Array<{
    id: number
    sample_id: number
    setup_id: number
    updated_at: string
  }> = [],
) {
  const samples = [...initialSamples]
  const measurements = [...initialMeasurements]
  const recordedData = new Map<number, Array<Record<string, unknown>>>()
  let nextSampleId = Math.max(9, ...samples.map((sample) => sample.id)) + 1
  let nextMeasurementId = Math.max(29, ...measurements.map((measurement) => measurement.id)) + 1

  apiMocks.structureList.mockResolvedValue({
    total: 1,
    items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
  })
  apiMocks.experimentList.mockResolvedValue({
    total: 1,
    items: [{ id: 2, name: 'DC experiment', source_bundle: experimentSourceBundle }],
  })
  apiMocks.sampleList.mockImplementation(async (request: { selected_ids?: number[] }) => ({
    total: samples.length,
    items: request.selected_ids?.length
      ? samples.filter((sample) => request.selected_ids?.includes(sample.id))
      : [...samples],
  }))
  apiMocks.setupList.mockResolvedValue({
    total: 1,
    items: [{ id: 20, experiment_id: 2, vars: { voltage: 5 }, material_parameters: {} }],
  })
  apiMocks.sampleUpsert.mockImplementation(
    async (
      records: Array<{
        material_parameters: Record<string, unknown>
        structure_id: number
        vars: Record<string, unknown>
      }>,
    ) => {
      const id = nextSampleId++
      samples.unshift({ ...records[0], id })
      return [{ id }]
    },
  )
  apiMocks.measurementContext.mockImplementation(async () => ({
    total: measurements.length,
    items: [...measurements],
  }))
  apiMocks.measurementList.mockImplementation(async (request: { selected_ids?: number[] }) => ({
    total: measurements.length,
    items: request.selected_ids?.length
      ? measurements.filter((measurement) => request.selected_ids?.includes(measurement.id))
      : [...measurements],
  }))
  apiMocks.measurementSave.mockImplementation(
    async (request: { recorded_data: Array<Record<string, unknown>>; sample_id: number; setup_id: number }) => {
      const existing = measurements.find(
        (measurement) => measurement.sample_id === request.sample_id && measurement.setup_id === request.setup_id,
      )
      const id = existing?.id ?? nextMeasurementId++
      const updated = {
        id,
        sample_id: request.sample_id,
        setup_id: request.setup_id,
        updated_at: new Date().toISOString(),
      }
      const index = measurements.findIndex((measurement) => measurement.id === id)
      if (index >= 0) measurements.splice(index, 1)
      measurements.unshift(updated)
      recordedData.set(id, request.recorded_data)
      return { id }
    },
  )
  apiMocks.recordedDataList.mockImplementation(async (request: { filter?: { measurement_id?: number[] } }) => {
    const measurementId = request.filter?.measurement_id?.[0]
    const rows = measurementId ? (recordedData.get(measurementId) ?? []) : []
    return {
      total: rows.length,
      items: rows.map((row, index) => ({
        ...row,
        id: (measurementId ?? 0) * 10 + index,
        measurement_id: measurementId,
      })),
    }
  })
  apiMocks.sampleDelete.mockResolvedValue(undefined)
  apiMocks.setupDelete.mockResolvedValue(undefined)
  apiMocks.measurementDelete.mockResolvedValue(undefined)

  return { measurements, recordedData, samples }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  solverMocks.autoComplete = false
  solverMocks.failRunNumbers = []
  solverMocks.rejectRunAttempts = 0
  solverMocks.runCount = 0
  solverMocks.staleSuccessBeforeRunNumbers = []
})

describe('MeasurementPage', () => {
  it('opens Analysis with the current Structure and Experiment context', async () => {
    mockRunWorkflow([])
    const router = renderPage('/measurements?structure=1&experiment=2')

    const analysisButton = await screen.findByRole('button', { name: '이 조합 분석' })
    await waitFor(() => expect(analysisButton).toBeEnabled())
    await userEvent.click(analysisButton)

    expect(router.state.location.pathname).toBe('/analysis')
    expect(new URLSearchParams(router.state.location.search)).toEqual(new URLSearchParams('structure=1&experiment=2'))
  })

  it('requests the split Results layout only for the Measurement viewer', async () => {
    mockRunWorkflow([])
    renderPage('/measurements?structure=1&experiment=2')

    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(expect.objectContaining({ resultsLayout: 'split' })),
    )
  })

  it('renders Sample, Setup, and Measurement data as unlabeled square buttons', async () => {
    mockRunWorkflow(
      [{ id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} }],
      [{ id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' }],
    )
    renderPage('/measurements?measurement=30')

    const sampleDot = await screen.findByRole('button', { name: 'Sample #10' })
    const setupDot = await screen.findByRole('button', { name: 'Setup #20' })
    const measurementDot = await screen.findByRole('button', { name: 'Measurement #30' })

    await waitFor(() => {
      expect(sampleDot).toHaveAttribute('aria-pressed', 'true')
      expect(setupDot).toHaveAttribute('aria-pressed', 'true')
      expect(measurementDot).toHaveAttribute('aria-pressed', 'true')
    })
    for (const dot of [sampleDot, setupDot, measurementDot]) {
      expect(dot).toHaveClass('size-3')
      expect(dot).not.toHaveClass('rounded-full')
      expect(dot).toHaveTextContent('')
    }
    expect(screen.queryByText('Sample #10')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup #20')).not.toBeInTheDocument()
    expect(screen.queryByText('Measurement #30')).not.toBeInTheDocument()
  })

  it('selects the newest Measurement and its Sample, Setup, and Recorded Data by default', async () => {
    const workflow = mockRunWorkflow(
      [
        { id: 11, structure_id: 1, vars: { width: 4 }, material_parameters: {} },
        { id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} },
      ],
      [
        { id: 31, sample_id: 11, setup_id: 20, updated_at: '2026-07-23T00:01:00Z' },
        { id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' },
      ],
    )
    workflow.recordedData.set(31, [
      {
        name: 'Current',
        quantity_kind: 'ElectricCurrent',
        tensor_order: 0,
        dtype: 'float64',
        data: { value: 31 },
      },
    ])
    const router = renderPage('/measurements?structure=1&experiment=2')

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('11')
      expect(params.get('setup')).toBe('20')
      expect(params.get('measurement')).toBe('31')
    })
    expect(screen.getByRole('button', { name: 'Sample #11' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Setup #20' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Measurement #31' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: { value: 31 } } }),
      ),
    )
  })

  it('selects the newest Sample and Setup when the context has no Measurement', async () => {
    mockRunWorkflow([
      { id: 11, structure_id: 1, vars: { width: 4 }, material_parameters: {} },
      { id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} },
    ])
    const router = renderPage('/measurements?structure=1&experiment=2')

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('11')
      expect(params.get('setup')).toBe('20')
      expect(params.get('measurement')).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'Sample #11' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Setup #20' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('preserves a partial Sample deep link and fills the missing Setup', async () => {
    mockRunWorkflow(
      [
        { id: 11, structure_id: 1, vars: { width: 4 }, material_parameters: {} },
        { id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} },
      ],
      [
        { id: 31, sample_id: 11, setup_id: 20, updated_at: '2026-07-23T00:01:00Z' },
        { id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' },
      ],
    )
    const router = renderPage('/measurements?structure=1&experiment=2&sample=10')

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('10')
      expect(params.get('setup')).toBe('20')
      expect(params.get('measurement')).toBe('30')
    })
    expect(screen.getByRole('button', { name: 'Sample #10' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Setup #20' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Measurement #30' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clears a selected Sample snapshot before rerolling a new random Sample', async () => {
    apiMocks.sampleList.mockResolvedValue({
      total: 1,
      items: [{ id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: { stored: true } }],
    })
    apiMocks.structureList.mockResolvedValue({
      total: 1,
      items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
    })
    apiMocks.experimentList.mockResolvedValue({ total: 0, items: [] })
    apiMocks.setupList.mockResolvedValue({ total: 0, items: [] })
    apiMocks.measurementContext.mockResolvedValue({ total: 0, items: [] })

    renderPage('/measurements?sample=10')

    expect(await screen.findByRole('button', { name: 'Sample #10' })).toBeInTheDocument()
    expect(workspaceSpy.mock.calls.every((call) => call[7] === 'fast-reroll')).toBe(true)
    expect(workspaceSpy.mock.calls.some((call) => call[4]?.width === 3)).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Sample 생성' }))

    await waitFor(() => {
      expect(workspaceSpy.mock.calls[workspaceSpy.mock.calls.length - 1]?.[4]).toBeUndefined()
    })
    expect(documentController.handleReroll).toHaveBeenCalledOnce()
  })

  it('creates a random Sample and runs it with the selected Setup', async () => {
    mockRunWorkflow([])
    solverMocks.autoComplete = true
    const router = renderPage('/measurements?structure=1&setup=20')

    const createAndRun = await screen.findByRole('button', {
      name: 'Sample 생성 + Run',
    })
    await waitFor(() => expect(createAndRun).toBeEnabled())
    await userEvent.click(createAndRun)

    await waitFor(() => expect(apiMocks.sampleUpsert).toHaveBeenCalledOnce())
    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(apiMocks.measurementSave).toHaveBeenCalledWith(
        expect.objectContaining({
          sample_id: 10,
          setup_id: 20,
          recorded_data: [
            expect.objectContaining({
              name: 'Current',
              quantity_kind: 'electromagnetism.ElectricCurrent',
              tensor_order: 0,
              dtype: 'float64',
              data_schema: {
                dtype: 'float64',
                quantityKind: 'electromagnetism.ElectricCurrent',
                unit: 'A',
              },
              data: persistedInlineTensor(1),
            }),
          ],
        }),
      ),
    )
    const measurementRequest = apiMocks.measurementSave.mock.calls[0][0]
    expect(JSON.stringify(measurementRequest)).not.toContain('intermediate-only-sentinel')
    expect(measurementRequest).not.toHaveProperty('trace')
    expect(measurementRequest).not.toHaveProperty('provenance')
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('10')
      expect(params.get('setup')).toBe('20')
      expect(params.get('measurement')).toBe('30')
    })
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: persistedInlineTensor(1) } }),
      ),
    )
  })

  it('keeps a newly created Sample when its automatic Solver run fails', async () => {
    mockRunWorkflow([])
    solverMocks.autoComplete = true
    solverMocks.failRunNumbers = [1]
    renderPage('/measurements?structure=1&setup=20')

    const createAndRun = await screen.findByRole('button', {
      name: 'Sample 생성 + Run',
    })
    await waitFor(() => expect(createAndRun).toBeEnabled())
    await userEvent.click(createAndRun)

    expect(await screen.findByRole('button', { name: 'Sample #10' })).toBeInTheDocument()
    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledOnce())
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('run 1 failed'))
    expect(apiMocks.measurementSave).not.toHaveBeenCalled()
    expect(apiMocks.sampleDelete).not.toHaveBeenCalled()
  })

  it('runs every unmeasured Sample sequentially, skips the measured pair, and continues after failure', async () => {
    mockRunWorkflow(
      [
        { id: 12, structure_id: 1, vars: { sampleId: 12 }, material_parameters: {} },
        { id: 11, structure_id: 1, vars: { sampleId: 11 }, material_parameters: {} },
        { id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} },
      ],
      [
        { id: 30, sample_id: 12, setup_id: 20, updated_at: '2026-07-23T00:02:00Z' },
        { id: 31, sample_id: 11, setup_id: 21, updated_at: '2026-07-23T00:01:00Z' },
      ],
    )
    solverMocks.autoComplete = true
    solverMocks.failRunNumbers = [1]
    const router = renderPage('/measurements?structure=1&setup=20')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (2)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledTimes(2))
    expect(solverMocks.run.mock.calls.map(([vars]) => vars)).toEqual([{ sampleId: 11 }, { sampleId: 10 }])
    await waitFor(() => expect(apiMocks.measurementSave).toHaveBeenCalledOnce())
    expect(apiMocks.measurementSave).toHaveBeenCalledWith(expect.objectContaining({ sample_id: 10, setup_id: 20 }))
    expect(await screen.findByText(/일괄 실행 완료 · 성공 1 · 실패 1/)).toBeInTheDocument()
    expect(screen.getByText('실패 Sample: #11')).toBeInTheDocument()
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('10')
      expect(params.get('measurement')).toBe('32')
    })
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: persistedInlineTensor(2) } }),
      ),
    )
    expect(apiMocks.structureList).toHaveBeenCalledTimes(1)
    expect(apiMocks.experimentList).toHaveBeenCalledTimes(1)
  })

  it('shows batch loading and Solver stages in order', async () => {
    mockRunWorkflow([
      { id: 11, structure_id: 1, vars: { sampleId: 11 }, material_parameters: {} },
      { id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} },
    ])
    const sampleListImplementation = apiMocks.sampleList.getMockImplementation()
    if (!sampleListImplementation) throw new Error('Sample list mock is missing.')
    let releaseLoad: (() => void) | undefined
    apiMocks.sampleList.mockImplementation(async (request: { selected_ids?: number[] }) => {
      if (request.selected_ids?.includes(11)) {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve
        })
      }
      return sampleListImplementation(request)
    })
    renderPage('/measurements?structure=1&setup=20&sample=10')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (2)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    expect(await screen.findByText('Sample 불러오는 중')).toBeInTheDocument()
    await waitFor(() => expect(releaseLoad).toBeDefined())
    act(() => releaseLoad?.())
    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledOnce())
    expect(screen.getByText('Solver 실행 중')).toBeInTheDocument()
  })

  it('keeps evaluating when an automatic run is rejected and retries with a real run ID', async () => {
    mockRunWorkflow([{ id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} }])
    solverMocks.autoComplete = true
    solverMocks.rejectRunAttempts = 1
    renderPage('/measurements?structure=1&setup=20')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (1)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(apiMocks.measurementSave).toHaveBeenCalledWith(expect.objectContaining({ sample_id: 10, setup_id: 20 })),
    )
    expect(await screen.findByText(/일괄 실행 완료 · 성공 1 · 실패 0/)).toBeInTheDocument()
  })

  it('ignores Recorded Data from a previous Solver run ID', async () => {
    mockRunWorkflow([{ id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} }])
    solverMocks.autoComplete = true
    solverMocks.staleSuccessBeforeRunNumbers = [1]
    renderPage('/measurements?structure=1&setup=20')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (1)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    await waitFor(() => expect(apiMocks.measurementSave).toHaveBeenCalledOnce())
    expect(apiMocks.measurementSave).toHaveBeenCalledWith(
      expect.objectContaining({
        recorded_data: [expect.objectContaining({ data: persistedInlineTensor(1) })],
      }),
    )
  })

  it('shows the Measurement saving stage before advancing batch progress', async () => {
    mockRunWorkflow([{ id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} }])
    solverMocks.autoComplete = true
    const saveImplementation = apiMocks.measurementSave.getMockImplementation()
    if (!saveImplementation) throw new Error('Measurement save mock is missing.')
    let releaseSave: (() => void) | undefined
    apiMocks.measurementSave.mockImplementation(
      async (request: { recorded_data: Array<Record<string, unknown>>; sample_id: number; setup_id: number }) => {
        await new Promise<void>((resolve) => {
          releaseSave = resolve
        })
        return saveImplementation(request)
      },
    )
    renderPage('/measurements?structure=1&setup=20')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (1)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    expect(await screen.findByText('Measurement 저장 중')).toBeInTheDocument()
    expect(screen.getByText(/0\/1 완료/)).toBeInTheDocument()
    await waitFor(() => expect(releaseSave).toBeDefined())
    act(() => releaseSave?.())
    expect(await screen.findByText(/일괄 실행 완료 · 성공 1 · 실패 0/)).toBeInTheDocument()
  })

  it('cancels the active Solver and leaves remaining batch Samples untouched', async () => {
    mockRunWorkflow([
      { id: 11, structure_id: 1, vars: { sampleId: 11 }, material_parameters: {} },
      { id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} },
    ])
    const runAllLabel = '미측정 Sample 모두 실행 (2)'
    renderPage('/measurements?structure=1&setup=20')

    const runAll = await screen.findByRole('button', { name: runAllLabel })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)
    await waitFor(() => expect(solverMocks.run).toHaveBeenCalledOnce())
    expect(screen.getByText('Solver 실행 중')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sample 생성' })).toBeDisabled()
    expect(screen.getByRole('button', { name: runAllLabel })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: '일괄 실행 취소' }))

    await waitFor(() => expect(solverMocks.cancel).toHaveBeenCalledOnce())
    expect(await screen.findByText(/일괄 실행 취소됨 · 성공 0 · 실패 0/)).toBeInTheDocument()
    expect(solverMocks.run).toHaveBeenCalledTimes(1)
    expect(apiMocks.measurementSave).not.toHaveBeenCalled()
  })

  it('restores the previous Measurement and Results when every batch item fails', async () => {
    const workflow = mockRunWorkflow(
      [
        { id: 12, structure_id: 1, vars: { sampleId: 12 }, material_parameters: {} },
        { id: 11, structure_id: 1, vars: { sampleId: 11 }, material_parameters: {} },
        { id: 10, structure_id: 1, vars: { sampleId: 10 }, material_parameters: {} },
      ],
      [{ id: 30, sample_id: 12, setup_id: 20, updated_at: '2026-07-23T00:02:00Z' }],
    )
    workflow.recordedData.set(30, [
      {
        name: 'Previous',
        dtype: 'float64',
        tensor_order: 0,
        quantity_kind: 'Dimensionless',
        data: { value: 99 },
      },
    ])
    solverMocks.autoComplete = true
    solverMocks.failRunNumbers = [1, 2]
    const router = renderPage('/measurements?structure=1&experiment=2&sample=12&setup=20&measurement=30')

    const runAll = await screen.findByRole('button', {
      name: '미측정 Sample 모두 실행 (2)',
    })
    await waitFor(() => expect(runAll).toBeEnabled())
    await userEvent.click(runAll)

    expect(await screen.findByText(/일괄 실행 완료 · 성공 0 · 실패 2/)).toBeInTheDocument()
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBe('12')
      expect(params.get('setup')).toBe('20')
      expect(params.get('measurement')).toBe('30')
    })
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Previous: { value: 99 } } }),
      ),
    )
  })

  it('restores a Measurement through its Sample and Setup and loads persisted Recorded Data', async () => {
    apiMocks.measurementList.mockResolvedValue({
      total: 1,
      items: [{ id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' }],
    })
    apiMocks.sampleList.mockResolvedValue({
      total: 1,
      items: [{ id: 10, structure_id: 1, vars: { width: 3 }, material_parameters: {} }],
    })
    apiMocks.setupList.mockResolvedValue({
      total: 1,
      items: [{ id: 20, experiment_id: 2, vars: { voltage: 5 }, material_parameters: {} }],
    })
    apiMocks.structureList.mockResolvedValue({
      total: 1,
      items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
    })
    apiMocks.experimentList.mockResolvedValue({
      total: 1,
      items: [{ id: 2, name: 'DC experiment', source_bundle: experimentSourceBundle }],
    })
    apiMocks.measurementContext.mockResolvedValue({
      total: 1,
      items: [{ id: 30, sample_id: 10, setup_id: 20, updated_at: '2026-07-23T00:00:00Z' }],
    })
    apiMocks.recordedDataList.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 40,
          measurement_id: 30,
          name: 'Current',
          quantity_kind: 'ElectricCurrent',
          tensor_order: 0,
          dtype: 'float64',
          data: { value: 2.5 },
        },
      ],
    })

    const router = renderPage('/viewer?structure=1&experiment=2&sample=10&setup=20&measurement=30')

    expect(await screen.findByText('Copper bar')).toBeInTheDocument()
    expect(screen.getByText('DC experiment')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Sample #10' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Setup #20' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Measurement #30' })).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.pathname).toBe('/viewer')
    expect(new URLSearchParams(router.state.location.search)).toEqual(
      new URLSearchParams('structure=1&experiment=2&sample=10&setup=20&measurement=30'),
    )
    expect(apiMocks.structureList).toHaveBeenCalledOnce()
    expect(apiMocks.experimentList).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recordedData: { Current: { value: 2.5 } },
        }),
      ),
    )
  })

  it('selects the Measurement and Results matching each Sample and Setup combination', async () => {
    mockMeasurementCombinations()
    const router = renderPage('/measurements?sample=10&setup=20')

    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('measurement')).toBe('30'))
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: { value: 30 } } }),
      ),
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Sample #11' }))
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('measurement')).toBe('31'))
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: { value: 31 } } }),
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Setup #21' }))
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('measurement')).toBe('32'))
    await waitFor(() =>
      expect(cadViewerSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ recordedData: { Current: { value: 32 } } }),
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Setup #22' }))
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('measurement')).toBeNull())
    await waitFor(() => expect(cadViewerSpy).toHaveBeenLastCalledWith(expect.objectContaining({ recordedData: null })))
  })

  it('deletes the selected Sample with its Measurement and keeps the Setup selected', async () => {
    mockSelectedMeasurement()
    const router = renderPage('/measurements?measurement=30')
    await screen.findByRole('button', { name: 'Measurement #30' })

    await userEvent.click(screen.getByRole('button', { name: '선택 Sample 삭제' }))
    expect(
      screen.getByText('이 Sample과 연결된 모든 Measurement 및 Recorded Data도 함께 삭제됩니다.'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '삭제' }))

    await waitFor(() => expect(apiMocks.sampleDelete).toHaveBeenCalledWith([10]))
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('sample')).toBeNull()
      expect(params.get('measurement')).toBeNull()
      expect(params.get('setup')).toBe('20')
    })
    expect(screen.getByRole('button', { name: '선택 Sample 삭제' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '선택 Setup 삭제' })).toBeEnabled()
    await waitFor(() => expect(cadViewerSpy).toHaveBeenLastCalledWith(expect.objectContaining({ recordedData: null })))
  })

  it('deletes the selected Setup with its Measurement and keeps the Sample selected', async () => {
    mockSelectedMeasurement()
    const router = renderPage('/measurements?measurement=30')
    await screen.findByRole('button', { name: 'Measurement #30' })

    await userEvent.click(screen.getByRole('button', { name: '선택 Setup 삭제' }))
    expect(
      screen.getByText('이 Setup과 연결된 모든 Measurement 및 Recorded Data도 함께 삭제됩니다.'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '삭제' }))

    await waitFor(() => expect(apiMocks.setupDelete).toHaveBeenCalledWith([20]))
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('setup')).toBeNull()
      expect(params.get('measurement')).toBeNull()
      expect(params.get('sample')).toBe('10')
    })
    expect(screen.getByRole('button', { name: '선택 Setup 삭제' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '선택 Sample 삭제' })).toBeEnabled()
  })

  it('deletes only the selected Measurement and clears Results', async () => {
    mockSelectedMeasurement()
    apiMocks.measurementDelete.mockImplementation(async () => {
      apiMocks.measurementContext.mockResolvedValue({ total: 0, items: [] })
    })
    const router = renderPage('/measurements?measurement=30')
    await screen.findByRole('button', { name: 'Measurement #30' })

    await userEvent.click(screen.getByRole('button', { name: '선택 Measurement 삭제' }))
    expect(
      screen.getByText('이 Measurement의 Recorded Data도 함께 삭제됩니다. Sample과 Setup은 유지됩니다.'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '삭제' }))

    await waitFor(() => expect(apiMocks.measurementDelete).toHaveBeenCalledWith([30]))
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('measurement')).toBeNull())
    expect(new URLSearchParams(router.state.location.search).get('sample')).toBe('10')
    expect(new URLSearchParams(router.state.location.search).get('setup')).toBe('20')
    expect(screen.getByRole('button', { name: '선택 Sample 삭제' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '선택 Setup 삭제' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '선택 Measurement 삭제' })).toBeDisabled()
    await waitFor(() => expect(cadViewerSpy).toHaveBeenLastCalledWith(expect.objectContaining({ recordedData: null })))
  })

  it('keeps the delete confirmation open when deletion fails', async () => {
    mockSelectedMeasurement()
    apiMocks.sampleDelete.mockRejectedValue(new Error('delete failed'))
    renderPage('/measurements?measurement=30')
    await screen.findByRole('button', { name: 'Measurement #30' })

    await userEvent.click(screen.getByRole('button', { name: '선택 Sample 삭제' }))
    await userEvent.click(screen.getByRole('button', { name: '삭제' }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('delete failed'))
    expect(screen.getByRole('heading', { name: 'Sample을 삭제할까요?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '삭제' })).toBeEnabled()
  })

  it('opens the Structure code manager with a Measurement return location', async () => {
    apiMocks.structureList.mockResolvedValue({
      total: 1,
      items: [{ id: 1, name: 'Copper bar', code: 'export default structure({})' }],
    })
    apiMocks.experimentList.mockResolvedValue({
      total: 1,
      items: [{ id: 2, name: 'DC experiment', source_bundle: experimentSourceBundle }],
    })
    apiMocks.sampleList.mockResolvedValue({ total: 0, items: [] })
    apiMocks.setupList.mockResolvedValue({ total: 0, items: [] })
    apiMocks.measurementContext.mockResolvedValue({ total: 0, items: [] })
    apiMocks.recordedDataList.mockResolvedValue({ total: 0, items: [] })

    const router = renderPage('/measurements?structure=1&experiment=2')
    await screen.findByText('Copper bar')
    expect(screen.getByRole('button', { name: '선택 Sample 삭제' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '선택 Setup 삭제' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '선택 Measurement 삭제' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '현재 Structure 편집' }))

    expect(router.state.location.pathname).toBe('/structures')
    expect(router.state.location.search).toBe('?structure=1&mode=code')
    expect(router.state.location.state).toEqual({
      measurementReturnTo: '/measurements?structure=1&experiment=2',
    })
  })

  it('preserves a full Viewer-alias context while opening the Structure editor', async () => {
    mockSelectedMeasurement()
    const returnTo = '/viewer?structure=1&experiment=2&sample=10&setup=20&measurement=30'
    const router = renderPage(returnTo)

    await screen.findByRole('button', { name: 'Measurement #30' })
    await userEvent.click(screen.getByRole('button', { name: '현재 Structure 편집' }))

    expect(router.state.location.pathname).toBe('/structures')
    expect(router.state.location.search).toBe('?structure=1&mode=code')
    expect(router.state.location.state).toEqual({ measurementReturnTo: returnTo })
  })
})
