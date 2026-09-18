import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const rows = [
  { id: 1, experiment_id: 10, vars: { x: 0.25 }, material_snapshot: snapshot, recorded_at: '2026-09-13' },
  { id: 2, experiment_id: 10, vars: { x: 0.8 }, material_snapshot: snapshot, recorded_at: null },
]
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
    onSelectedResultChange,
    showToolbar,
    recordedData,
  }: {
    experimentDocument: { variables: Vars }
    showToolbar?: boolean
    selectedResult: string
    recordedData?: unknown
    onSelectedResultChange: (name: string) => void
  }) => (
    <div>
      <output aria-label="Viewer Vars">{JSON.stringify(experimentDocument.variables)}</output>
      <output aria-label="Viewer data">{JSON.stringify(recordedData)}</output>
      <output aria-label="Viewer selected result">{selectedResult}</output>
      {showToolbar !== false && (
        <select
          aria-label="Viewer 결과 선택"
          value={selectedResult}
          onChange={(event) => onSelectedResultChange(event.target.value)}
        >
          <option value="">Geometry</option>
          <option value="result">result</option>
        </select>
      )}
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
  measurementActions: { runReviewed: mocks.run, cancel: mocks.cancel },
  calculationDataActions: {},
} as unknown as CaeWorkbenchState
function view(active = true, state = workbench) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MeasurementWorkspace workbench={state} authenticated dataReadable active={active} menubar={<nav>Tabs</nav>} />
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
  rows.splice(2)
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    const preview = within(screen.getByLabelText('미리보기 Viewer'))
    const actual = within(screen.getByLabelText('실제 결과 Viewer'))
    const initialPreview = preview.getByLabelText('Viewer Vars').textContent
    fireEvent.click(screen.getByText('선택 Run'))
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
    expect(screen.getAllByLabelText('비교 Viewer 공통 툴바')).toHaveLength(1)
  })

  it('keeps the last frame and ignores a late prediction after cancellation', async () => {
    const prediction = deferred<{ data: { result: string }; error: string }>()
    mocks.predict.mockReturnValue(prediction.promise)
    render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    const previous = screen.getAllByLabelText('Viewer Vars').map((item) => item.textContent)
    fireEvent.click(screen.getByText('선택 Run'))
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    fireEvent.click(screen.getByText('선택 Run'))
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    fireEvent.click(screen.getByText('선택 Run'))
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    fireEvent.click(screen.getByText('선택 Run'))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    await act(async () => notify())
    await waitFor(() => expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:100'))
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await act(async () => completion.resolve({ measurementId: 100 }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument())
    expect(screen.getByText('전체 후보 Run')).toBeDisabled()
    expect(
      within(screen.getByLabelText('실제 결과 Viewer')).getByText('실제 결과 · Measurement #100'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:100')
  })

  it('discards a background candidate after the Experiment context changes', async () => {
    const prediction = deferred<{ data: { result: string }; error: string }>()
    mocks.predict.mockReturnValue(prediction.promise)
    const rendered = render(view())
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).toBeEnabled())
    fireEvent.click(screen.getByText('선택 Run'))
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
    render(view())
    const actual = screen.getByLabelText('실제 결과 Viewer')
    await waitFor(() => expect(within(actual).getByLabelText('Viewer Vars')).toHaveTextContent('0.25'))
    fireEvent.change(screen.getByLabelText('x', { exact: true }), { target: { value: '0.6' } })
    expect(screen.getByText('선택 Run')).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText('x', { exact: true }), { key: 'Enter' })
    await waitFor(() =>
      expect(within(screen.getByLabelText('미리보기 Viewer')).getByLabelText('Viewer Vars')).toHaveTextContent('0.6'),
    )
    expect(within(actual).getByLabelText('Viewer Vars')).toHaveTextContent('0.25')
    expect(within(actual).getByText('비교 기준 · 현재 Vars와 다름')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Viewer 결과 선택')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'result' } })
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('후보 생성 방식'), { target: { value: 'empty-lhs' } })
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    expect(mocks.run).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('선택 Run')).not.toBeDisabled())
    fireEvent.click(screen.getByText('선택 Run'))
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
    await waitFor(() => expect(screen.getByRole('button', { name: '후보 생성' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '후보 생성' }))
    await waitFor(() => expect(screen.getByText('선택 Run')).not.toBeDisabled())
    fireEvent.click(screen.getByText('선택 Run'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Calculation failed'))
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1')
    expect(screen.getByText('전체 후보 Run')).toBeDisabled()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
})

it('applies saved data selection after the actual Measurement loads, then keeps manual selection', async () => {
  const load = deferred<(typeof rows)[number]>()
  mocks.load.mockReturnValueOnce(load.promise)
  const defaults = { version: 1 as const, selectedResult: 'result', settings: {}, camera: null }
  render(view(true, { ...workbench, experimentRecord: { ...workbench.experimentRecord!, viewer_defaults: defaults } }))
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('')
  await act(async () => load.resolve(rows[0]))
  await waitFor(() => expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('result'))
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: '' } })
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('')
})
