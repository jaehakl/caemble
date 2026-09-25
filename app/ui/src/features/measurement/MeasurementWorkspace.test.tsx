import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { Vars } from '@/lib/cad/model/types'
import { MeasurementWorkspace as MeasurementWorkspaceView } from './MeasurementWorkspace'
import { useMeasurementSession } from './useMeasurementSession'
import { fitMeasurementProjection, type VarsPoint } from './measurementSpace'
import type { VarsSchema } from '@/lib/cad/model/vars'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  save: vi.fn(),
  cancel: vi.fn(),
  prepare: vi.fn(),
  predict: vi.fn(),
  evaluate: vi.fn(),
  load: vi.fn(),
  deleteMeasurements: vi.fn(),
  confirm: vi.fn(),
}))
const schema = { x: { shape: [], min: 0, max: 1 } }
const snapshot = {
  sourceHash: 'source',
  varsHash: 'vars',
  modelDefinitions: [],
  selections: {},
  experiment: { materials: {} },
  tasks: {},
}
const initialRows = [
  { id: 1, experiment_id: 10, vars: { x: 0.25 }, material_snapshot: snapshot, recorded_at: '2026-09-13' },
  { id: 2, experiment_id: 10, vars: { x: 0.8 }, material_snapshot: snapshot, recorded_at: null },
]
let rows = [...initialRows]
vi.mock('@/api', () => ({ getListRequest: () => ({}), dbTables: { Measurement: { create: mocks.save } } }))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'public' }))
vi.mock('./queryOptions', () => ({
  measurementsQueryOptions: () => ({ queryKey: ['measurements'], queryFn: async () => ({ items: rows }) }),
}))
vi.mock('./queryInvalidation', () => ({ invalidateMeasurementMutation: async () => {} }))
vi.mock('./useMeasurementForward', () => ({
  useMeasurementForward: () => ({
    model: null,
    build: vi.fn(),
    prepare: mocks.prepare,
    predict: mocks.predict,
    building: false,
    predicting: false,
    error: '',
  }),
}))
vi.mock('./useCaeDataSelection', () => ({
  useCaeDataSelection: () => {
    const [row, setRow] = useState<(typeof rows)[number] | null>(null)
    const loadMeasurement = useCallback(
      async (value: (typeof rows)[number] | number, _experiment?: number, options?: { signal?: AbortSignal }) => {
        const next = await mocks.load(value)
        if (options?.signal?.aborted) return null
        setRow(next)
        return next
      },
      [],
    )
    return {
      measurement: row,
      variables: row?.vars,
      materialSnapshot: row?.material_snapshot,
      loadMeasurement,
      clearMeasurement: () => setRow(null),
      recordedRules: [],
      flatRecordedData: row ? { result: `actual:${row.vars.x}` } : {},
      resultContracts: { result: { visualization: { kind: 'box-grid' } } },
    }
  },
}))
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: (_source: unknown, _change: unknown, options: { candidateVars?: Vars; resetKey?: number }) => {
    const [status, setStatus] = useState(options.resetKey === undefined ? 'Evaluating' : 'Ready')
    useEffect(() => {
      if (options.resetKey !== undefined) return
      let current = true
      void mocks.evaluate(options.candidateVars).then(() => {
        if (current) setStatus('Ready')
      })
      return () => {
        current = false
      }
    }, [options.candidateVars, options.resetKey])
    const experimentDocument = useMemo(
      () => ({
        variables: options.candidateVars,
        status,
        revision: 1,
        successfulRevision: 1,
        materialSnapshot: snapshot,
        varsSchema: schema,
        draftTaskNames: [],
        simulationProgram: { resultContracts: {} },
      }),
      [options.candidateVars, status],
    )
    return { experimentDocument }
  },
}))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: ({
    experimentDocument,
    selectedResult,
    recordedData,
  }: {
    experimentDocument: { variables: Vars }
    selectedResult: string
    recordedData?: unknown
  }) => (
    <div>
      <output aria-label="Viewer Vars">{JSON.stringify(experimentDocument.variables)}</output>
      <output aria-label="Viewer data">{JSON.stringify(recordedData)}</output>
      <output aria-label="Viewer selected result">{selectedResult}</output>
    </div>
  ),
}))

const workbench = {
  experimentId: 10,
  experiment: { kind: 'experiment', sourceBundle: { files: {} } },
  experimentRecord: { source_hash: 'source' },
  experimentClean: true,
  experimentManageable: true,
  workspaceSession: 1,
  candidateVars: { x: 0.25 },
  experimentDocument: { varsSchema: schema },
  selection: { measurement: rows[0], variables: rows[0].vars },
  measurementActions: { runReviewed: mocks.run, cancel: mocks.cancel, deleteMeasurements: mocks.deleteMeasurements },
  calculationDataActions: {},
} as unknown as CaeWorkbenchState
function MeasurementWorkspace({
  authenticated,
  ...props
}: Omit<Parameters<typeof MeasurementWorkspaceView>[0], 'session'> & { authenticated: boolean }) {
  const session = useMeasurementSession({ ...props, authenticated })
  return <MeasurementWorkspaceView {...props} session={session} />
}
function view(active = true, state = workbench, authenticated = true) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MeasurementWorkspace
        workbench={state}
        authenticated={authenticated}
        dataReadable
        active={active}
        menubar={<nav>Tabs</nav>}
      />
    </QueryClientProvider>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  rows = [...initialRows]
  mocks.confirm.mockReturnValue(true)
  vi.stubGlobal('confirm', mocks.confirm)
  mocks.deleteMeasurements.mockImplementation(async (selected: typeof rows) => {
    const ids = new Set(selected.map((row) => row.id))
    rows = rows.filter((row) => !ids.has(row.id))
    return true
  })
  mocks.evaluate.mockResolvedValue(undefined)
  mocks.load.mockImplementation(async (value) =>
    typeof value === 'number' ? (rows.find((row) => row.id === value) ?? rows[0]) : value,
  )
  mocks.prepare.mockResolvedValue({ session: null, error: '' })
  mocks.predict.mockResolvedValue({ data: undefined, rules: undefined, error: '' })
  mocks.run.mockImplementation(async (input) => ({ candidateId: input.candidateId, measurementId: 1 }))
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(input: { id: number; schema: VarsSchema; points: VarsPoint[] }) {
        const projection = fitMeasurementProjection(input.schema, input.points)
        queueMicrotask(() => this.onmessage?.({ data: { id: input.id, projection } }))
      }
      terminate() {
        this.onmessage = null
      }
    },
  )
})

describe('Measurement workspace integration', () => {
  it.each(['draft', 'measurement:2'])(
    'runs only the selected %s and removes the waiting-candidate controls',
    async (id) => {
      render(view())
      await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
      expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
      for (const name of ['전체 실행', '샘플 추가', '샘플 생성', '선택 후보 삭제']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
      fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: id } })
      await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: '실행' }))
      await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
      expect(mocks.run).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: id,
          vars: { x: id === 'draft' ? 0.25 : 0.8 },
          measurementId: id === 'draft' ? undefined : 2,
          materialSnapshot: snapshot,
        }),
        expect.any(Function),
        expect.any(Function),
      )
      await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    },
  )

  it('does not overwrite a newer explicit selection when a single run finishes late', async () => {
    const completion = deferred<{ candidateId: string; measurementId: number }>()
    mocks.run.mockReturnValue(completion.promise)
    render(view())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'draft' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'measurement:2' } })
    await act(async () => completion.resolve({ candidateId: 'draft', measurementId: 1 }))
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:2')
  })

  it('retains recorded results when their subsequent Calculation fails', async () => {
    mocks.run.mockImplementation(async (_input, progress, recorded) => {
      progress({ state: 'succeeded', measurementId: 1, error: null })
      recorded(1)
      throw new Error('Calculation failed')
    })
    render(view())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'draft' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(screen.getByText('Calculation failed')).toBeInTheDocument())
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1')
    expect(within(screen.getByLabelText('실제 결과 Viewer')).getByLabelText('Viewer data')).toHaveTextContent(
      'actual:0.25',
    )
  })

  it('deletes a Recorded measurement and clears its displayed results only after success', async () => {
    mocks.confirm.mockReturnValueOnce(false)
    mocks.deleteMeasurements.mockResolvedValueOnce(false)
    render(view(true, { ...workbench, experimentIsDemo: true }))
    expect(screen.queryByRole('button', { name: 'Prepared 저장' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '저장' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '예측 모델' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    await waitFor(() =>
      expect(within(screen.getByLabelText('실제 결과 Viewer')).getByLabelText('Viewer data')).toHaveTextContent(
        'actual:0.25',
      ),
    )
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    expect(mocks.deleteMeasurements).not.toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('Recorded Measurement 1개'))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('RecordedData도 함께 삭제'))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('공개 Demo 데이터에 즉시 반영'))
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    await waitFor(() => expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled())
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1')
    expect(within(screen.getByLabelText('실제 결과 Viewer')).getByLabelText('Viewer data')).toHaveTextContent(
      'actual:0.25',
    )
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    await waitFor(() => expect(screen.queryByRole('option', { name: '#1 · Recorded' })).not.toBeInTheDocument())
    expect(mocks.deleteMeasurements).toHaveBeenLastCalledWith([initialRows[0]])
    expect(screen.getByLabelText('점 선택')).toHaveValue('draft')
    expect(screen.getByText('Recorded Measurement를 선택하면 실제 결과를 표시합니다.')).toBeInTheDocument()
    expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.25')
    expect(screen.getByRole('option', { name: '#2 · Prepared' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Measurement #1 · recorded' })).not.toBeInTheDocument(),
    )
  })

  it('deletes a selected Prepared measurement despite invalid Vars and preserves the current Vars', async () => {
    render(view())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'measurement:2' } })
    await waitFor(() =>
      expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.8'),
    )
    fireEvent.change(screen.getByLabelText('x', { exact: true }), { target: { value: '2' } })
    expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
    expect(screen.queryByText('선택 후보 삭제')).not.toBeInTheDocument()
    expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled()
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('1개'))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('#2'))
    await waitFor(() => expect(screen.queryByRole('option', { name: '#2 · Prepared' })).not.toBeInTheDocument())
    expect(mocks.deleteMeasurements).toHaveBeenCalledExactlyOnceWith([initialRows[1]])
    expect(screen.getByLabelText('점 선택')).toHaveValue('draft')
    expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.8')
    expect(screen.getByRole('option', { name: '#1 · Recorded' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Measurement #2 · prepared' })).not.toBeInTheDocument(),
    )
  })

  it('keeps the selection and data when Prepared deletion is cancelled or rejected', async () => {
    mocks.confirm.mockReturnValueOnce(false)
    mocks.deleteMeasurements.mockResolvedValueOnce(false)
    const rendered = render(view())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'measurement:2' } })
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    expect(mocks.deleteMeasurements).not.toHaveBeenCalled()
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:2')
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    await waitFor(() => expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled())
    rendered.rerender(
      view(true, {
        ...workbench,
        measurementActions: {
          ...workbench.measurementActions,
          error: 'Cancel active CAE jobs before deleting their Measurements.',
        },
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Cancel active CAE jobs')
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:2')
    expect(screen.getByRole('option', { name: '#2 · Prepared' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Measurement #2 · prepared' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('disables Measurement deletion without selection, permission, or while busy', async () => {
    const rendered = render(view())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'draft' } })
    expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('점 선택'), { target: { value: 'measurement:2' } })
    expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled()
    rendered.rerender(view(true, workbench, false))
    expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
    rendered.rerender(view(true, { ...workbench, experimentManageable: false }))
    expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
    for (const action of ['measurementActions', 'calculationDataActions'] as const) {
      rendered.rerender(view(true, { ...workbench, [action]: { ...workbench[action], busy: true } }))
      expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
    }
    rendered.rerender(view())
    const completion = deferred<boolean>()
    mocks.deleteMeasurements.mockReturnValueOnce(completion.promise)
    fireEvent.click(screen.getByText('선택 Measurement 삭제'))
    expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
    expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument()
    await act(async () => completion.resolve(false))
    expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled()
    expect(mocks.deleteMeasurements).toHaveBeenCalledTimes(1)
  })

  it('restores a late initial Recorded selection under StrictMode', async () => {
    const unloaded = { ...workbench, selection: { ...workbench.selection, measurement: null } }
    const rendered = render(<StrictMode>{view(true, unloaded)}</StrictMode>)
    expect(screen.getByText('Recorded Measurement를 선택하면 실제 결과를 표시합니다.')).toBeInTheDocument()
    rendered.rerender(<StrictMode>{view()}</StrictMode>)
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1'))
    expect(within(screen.getByLabelText('실제 결과 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.25')
  })
  it('keeps the actual Vars while editing a new candidate and synchronizes viewer result selection', async () => {
    const user = userEvent.setup()
    render(view())
    const actual = screen.getByLabelText('실제 결과 Viewer')
    await waitFor(() => expect(within(actual).getByLabelText('Viewer Vars')).toHaveTextContent('0.25'))
    fireEvent.change(screen.getByLabelText('x', { exact: true }), { target: { value: '0.6' } })
    expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText('x', { exact: true }), { key: 'Enter' })
    await waitFor(() =>
      expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.6'),
    )
    expect(within(actual).getByLabelText('Viewer Vars')).toHaveTextContent('0.25')
    expect(within(actual).getByText('비교 기준 · 현재 Vars와 다름')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Output ·/ })).toHaveLength(1)
    expect(screen.queryByRole('toolbar', { name: 'Output 설정 툴바' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Output · 선택 안 함' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'result' }))
    expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer selected result')).toHaveTextContent(
      'result',
    )
    expect(within(actual).getByLabelText('Viewer selected result')).toHaveTextContent('result')
    expect(screen.getByRole('separator', { name: '미리보기와 실제 결과 너비 조절' })).toHaveAttribute(
      'aria-orientation',
      'vertical',
    )
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})

it('applies saved data selection after the actual Measurement loads, then keeps manual selection', async () => {
  const user = userEvent.setup()
  const load = deferred<(typeof rows)[number]>()
  mocks.load.mockReturnValueOnce(load.promise)
  const defaults = { version: 1 as const, selectedResult: 'result', settings: {}, camera: null }
  render(view(true, { ...workbench, experimentRecord: { ...workbench.experimentRecord!, viewer_defaults: defaults } }))
  expect(screen.getByRole('button', { name: 'Output · 선택 안 함' })).toBeInTheDocument()
  await act(async () => load.resolve(rows[0]))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Output · result' })).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: 'Output · result' }))
  await user.click(screen.getByRole('menuitemradio', { name: '선택 안 함' }))
  expect(screen.getByRole('button', { name: 'Output · 선택 안 함' })).toBeInTheDocument()
})

it('retains a v2 Output selection when the current Measurement temporarily lacks it', async () => {
  const defaults = {
    version: 2 as const,
    geometryMode: 0.5 as const,
    selectedOutput: 'temporarily-missing',
    visualizations: { polyline: '' },
    settings: {},
    camera: null,
  }
  render(view(true, { ...workbench, experimentRecord: { ...workbench.experimentRecord!, viewer_defaults: defaults } }))
  await waitFor(() => expect(mocks.load).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Output · temporarily-missing' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Geometry · 50%' })).toBeInTheDocument()
})
