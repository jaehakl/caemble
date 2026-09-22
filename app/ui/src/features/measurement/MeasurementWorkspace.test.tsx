import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { Vars } from '@/lib/cad/model/types'
import { MeasurementWorkspace } from './MeasurementWorkspace'
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
    expect(screen.getByText('선택 후보 삭제')).toBeDisabled()
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

  it.each(['candidate', 'mixed'] as const)(
    'deletes the Prepared linked to a failed candidate with %s selection and removes both points',
    async (selection) => {
      mocks.run.mockImplementationOnce(async (input, progress) => {
        rows = [...rows, { ...initialRows[1], id: 100, vars: input.vars }]
        progress({ measurementId: 100, state: 'failed', error: 'Solver failed' })
        throw new Error('Solver failed')
      })
      render(view())
      await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
      fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: '실행' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Measurement #100 · prepared' })).toBeInTheDocument(),
      )
      await waitFor(() => expect(screen.getByText('선택 Measurement 삭제')).toBeEnabled())
      const candidateVars = mocks.run.mock.calls[0][0].vars
      mocks.confirm.mockReturnValueOnce(false)
      fireEvent.click(screen.getByText('선택 Measurement 삭제'))
      expect(mocks.deleteMeasurements).not.toHaveBeenCalled()
      expect(screen.getByRole('option', { name: /후보 1 · failed/ })).toBeInTheDocument()
      if (selection === 'mixed') {
        fireEvent.keyDown(screen.getByRole('button', { name: 'Measurement #100 · prepared' }), {
          key: 'Enter',
          ctrlKey: true,
        })
        fireEvent.keyDown(screen.getByRole('button', { name: 'Measurement #1 · recorded' }), {
          key: 'Enter',
          ctrlKey: true,
        })
      }
      fireEvent.click(screen.getByText('선택 Measurement 삭제'))
      await waitFor(() => expect(screen.queryByRole('option', { name: '#100 · Prepared' })).not.toBeInTheDocument())
      expect(mocks.deleteMeasurements).toHaveBeenCalledExactlyOnceWith(
        selection === 'mixed'
          ? [initialRows[0], expect.objectContaining({ id: 100 })]
          : [expect.objectContaining({ id: 100 })],
      )
      expect(screen.queryByRole('option', { name: /후보 1 · failed/ })).not.toBeInTheDocument()
      await waitFor(() => expect(screen.queryByRole('button', { name: '후보 1 · failed' })).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Measurement #100 · prepared' })).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      if (selection === 'candidate') {
        expect(screen.getByLabelText('점 선택')).toHaveValue('draft')
        expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars').textContent).toBe(
          JSON.stringify(candidateVars),
        )
      } else {
        expect(screen.getByLabelText('점 선택')).toHaveValue('draft')
        expect(screen.queryByRole('option', { name: '#1 · Recorded' })).not.toBeInTheDocument()
        expect(screen.getByText('Recorded Measurement를 선택하면 실제 결과를 표시합니다.')).toBeInTheDocument()
      }
      expect(screen.getByText('선택 Measurement 삭제')).toBeDisabled()
      expect(screen.getByText('선택 후보 삭제')).toBeDisabled()
    },
  )

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

  it('retains both frames through three candidates and publishes actual results before Calculation finishes', async () => {
    const cad = Array.from({ length: 3 }, () => deferred<void>())
    const training = Array.from({ length: 4 }, () => deferred<{ session: null; error: string }>())
    const predictions = Array.from({ length: 3 }, () =>
      deferred<{ data: { result: string }; rules: never[]; error: string }>(),
    )
    const completions = Array.from({ length: 3 }, () => deferred<{ measurementId: number }>())
    const downloads = Array.from({ length: 3 }, () => deferred<void>())
    const recorded: Array<() => void> = []
    mocks.evaluate.mockImplementation(() => cad[mocks.evaluate.mock.calls.length - 1].promise)
    mocks.prepare.mockImplementation(() => training[mocks.prepare.mock.calls.length - 1].promise)
    mocks.predict.mockImplementation(() => predictions[mocks.predict.mock.calls.length - 1].promise)
    mocks.load.mockImplementation(async (value) => {
      if (typeof value !== 'number') return value
      if (value >= 100) await downloads[value - 100].promise
      return rows.find((row) => row.id === value)
    })
    mocks.run.mockImplementation((input, progress, onRecorded) => {
      const index = mocks.run.mock.calls.length - 1
      recorded[index] = () => {
        rows.push({ ...rows[0], id: 100 + index, vars: input.vars })
        progress({ measurementId: 100 + index, state: 'succeeded', error: null })
        onRecorded(100 + index)
      }
      return completions[index].promise
    })
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    const preview = within(screen.getByLabelText('미리보기 Viewer'))
    const actual = within(screen.getByLabelText('실제 결과 Viewer'))
    const initialPreview = preview.getByLabelText('Viewer Vars').textContent
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.evaluate).toHaveBeenCalledTimes(1))
    await act(async () => training[0].resolve({ session: null, error: '' }))
    expect(mocks.predict).not.toHaveBeenCalled()
    expect(preview.getByLabelText('Viewer Vars').textContent).toBe(initialPreview)

    for (let index = 0; index < 3; index++) {
      await act(async () => {
        cad[index].resolve()
        training[index].resolve({ session: null, error: '' })
      })
      await waitFor(() => expect(mocks.predict).toHaveBeenCalledTimes(index + 1))
      if (index) {
        expect(preview.getByLabelText('Viewer data')).toHaveTextContent(`prediction:${index - 1}`)
        expect(actual.getByLabelText('Viewer Vars').textContent).toBe(
          JSON.stringify(mocks.run.mock.calls[index - 1][0].vars),
        )
      }
      await act(async () =>
        predictions[index].resolve({ data: { result: `prediction:${index}` }, rules: [], error: '' }),
      )
      await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(index + 1))
      const input = mocks.run.mock.calls[index][0]
      expect(preview.getByLabelText('Viewer Vars').textContent).toBe(JSON.stringify(input.vars))
      expect(preview.getByLabelText('Viewer data')).toHaveTextContent(`prediction:${index}`)
      const previousActual = actual.getByLabelText('Viewer Vars').textContent
      await act(async () => recorded[index]())
      await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(index + 2))
      if (index < 2) await waitFor(() => expect(mocks.evaluate).toHaveBeenCalledTimes(index + 2))
      expect(actual.getByLabelText('Viewer Vars').textContent).toBe(previousActual)
      await act(async () => downloads[index].resolve())
      await waitFor(() => expect(actual.getByLabelText('Viewer Vars').textContent).toBe(JSON.stringify(input.vars)))
      expect(preview.getByLabelText('Viewer data')).toHaveTextContent(`prediction:${index}`)
      expect(mocks.run).toHaveBeenCalledTimes(index + 1)
      await act(async () => completions[index].resolve({ measurementId: 100 + index }))
    }
    await act(async () => training[3].resolve({ session: null, error: '' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument())
    expect(mocks.prepare).toHaveBeenCalledTimes(4)
    expect(mocks.predict).toHaveBeenCalledTimes(3)
    expect(preview.getByLabelText('Viewer data')).toHaveTextContent('prediction:2')
    expect(screen.getAllByRole('button', { name: /표시 데이터 종류 변경/ })).toHaveLength(1)
  })

  it('keeps the last frame and ignores a late prediction after cancellation', async () => {
    const prediction = deferred<{ data: { result: string }; error: string }>()
    mocks.predict.mockReturnValue(prediction.promise)
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    const previous = screen.getAllByLabelText('Viewer Vars').map((item) => item.textContent)
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.predict).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await act(async () => prediction.resolve({ data: { result: 'late' }, error: '' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument())
    expect(screen.getAllByLabelText('Viewer Vars').map((item) => item.textContent)).toEqual(previous)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('late')).not.toBeInTheDocument()
  })

  it('switches the next preview while the previous Calculation is pending, without starting another Solver', async () => {
    const completion = deferred<{ measurementId: number }>()
    let notify!: () => void
    mocks.predict.mockImplementation(async (_model, _document, vars) => ({
      data: { result: `prediction:${vars.x}` },
      error: '',
    }))
    mocks.run.mockImplementationOnce((input, _progress, onRecorded) => {
      rows.push({ ...rows[0], id: 100, vars: input.vars })
      notify = () => onRecorded(100)
      return completion.promise
    })
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    await act(async () => notify())
    await waitFor(() => expect(mocks.predict).toHaveBeenCalledTimes(2))
    const nextVars = mocks.predict.mock.calls[1][2]
    await waitFor(() =>
      expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars').textContent).toBe(
        JSON.stringify(nextVars),
      ),
    )
    expect(within(screen.getByLabelText('실제 결과 Viewer')).getByLabelText('Viewer Vars').textContent).toBe(
      JSON.stringify(mocks.run.mock.calls[0][0].vars),
    )
    expect(mocks.run).toHaveBeenCalledTimes(1)
    await act(async () => completion.resolve({ measurementId: 100 }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2))
    expect(mocks.run.mock.calls[1][0].vars).toEqual(nextVars)
  })

  it('continues after a Solver failure and keeps CAD-only candidates runnable', async () => {
    mocks.predict.mockResolvedValue({ data: undefined, error: '학습 실패 · CAD만 표시합니다.' })
    mocks.run.mockRejectedValueOnce(new Error('Solver failed'))
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Solver failed')
    expect(
      within(screen.getByLabelText('미리보기 Viewer')).getByText('학습 실패 · CAD만 표시합니다.'),
    ).toBeInTheDocument()
    expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer selected result')).toHaveTextContent(
      '',
    )
  })

  it('keeps an already recorded candidate after cancellation during Calculation', async () => {
    const completion = deferred<{ measurementId: number }>()
    let notify!: () => void
    mocks.run.mockImplementationOnce((input, _progress, onRecorded) => {
      rows.push({ ...rows[0], id: 100, vars: input.vars })
      notify = () => onRecorded(100)
      return completion.promise
    })
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    await act(async () => notify())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:100'))
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await act(async () => completion.resolve({ measurementId: 100 }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '전체 실행' })).toBeDisabled()
    expect(
      within(screen.getByLabelText('실제 결과 Viewer')).getByText('실제 결과 · Measurement #100'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:100')
  })

  it('discards a background candidate after the Experiment context changes', async () => {
    const prediction = deferred<{ data: { result: string }; error: string }>()
    mocks.predict.mockReturnValue(prediction.promise)
    const rendered = render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.predict).toHaveBeenCalled())
    rendered.rerender(view(true, { ...workbench, workspaceSession: 2 }))
    await act(async () => prediction.resolve({ data: { result: 'stale' }, error: '' }))
    expect(mocks.run).not.toHaveBeenCalled()
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument()
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
    expect(screen.getAllByRole('button', { name: /표시 데이터 종류 변경/ })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '표시 데이터 종류 변경 · Geometry' }))
    await user.click(screen.getByRole('menuitem', { name: 'result · Output' }))
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
  it('generates candidates without execution then submits each reviewed candidate exactly once', async () => {
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 방식'), { target: { value: 'empty-lhs' } })
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    expect(mocks.run).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2))
    const submitted = mocks.run.mock.calls.map(([input]) => input)
    expect(new Set(submitted.map((input) => input.candidateId)).size).toBe(2)
    expect(
      submitted.every((input) => input.candidateId.startsWith('candidate:') && input.vars.x >= 0 && input.vars.x <= 1),
    ).toBe(true)
    expect(submitted[0].vars.x).not.toBe(submitted[1].vars.x)
  })
  it('retains the Recorded result when Calculation postprocessing fails', async () => {
    mocks.run.mockImplementation(async (_input, onProgress) => {
      onProgress({ measurementId: 1, state: 'succeeded', error: null })
      throw new Error('Calculation failed')
    })
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '샘플 생성' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('샘플 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '샘플 생성' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '실행' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Calculation failed'))
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1')
    expect(screen.getByRole('button', { name: '전체 실행' })).toBeDisabled()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
})

it('applies saved data selection after the actual Measurement loads, then keeps manual selection', async () => {
  const user = userEvent.setup()
  const load = deferred<(typeof rows)[number]>()
  mocks.load.mockReturnValueOnce(load.promise)
  const defaults = { version: 1 as const, selectedResult: 'result', settings: {}, camera: null }
  render(view(true, { ...workbench, experimentRecord: { ...workbench.experimentRecord!, viewer_defaults: defaults } }))
  expect(screen.getByRole('button', { name: '표시 데이터 종류 변경 · Geometry' })).toBeInTheDocument()
  await act(async () => load.resolve(rows[0]))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '표시 데이터 종류 변경 · result' })).toBeInTheDocument(),
  )
  await user.click(screen.getByRole('button', { name: '표시 데이터 종류 변경 · result' }))
  await user.click(screen.getByRole('menuitem', { name: 'Geometry' }))
  expect(screen.getByRole('button', { name: '표시 데이터 종류 변경 · Geometry' })).toBeInTheDocument()
})
