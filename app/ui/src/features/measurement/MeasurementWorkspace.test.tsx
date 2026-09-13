import { StrictMode, useCallback, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { Vars } from '@/lib/cad/model/types'
import { MeasurementWorkspace } from './MeasurementWorkspace'
import { fitMeasurementProjection, type VarsPoint } from './measurementSpace'
import type { VarsSchema } from '@/lib/cad/model/vars'

const mocks = vi.hoisted(() => ({ run: vi.fn(), save: vi.fn(), cancel: vi.fn() }))
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
  useMeasurementForward: () => ({ model: null, build: vi.fn(), building: false, predicting: false }),
}))
vi.mock('./useCaeDataSelection', () => ({
  useCaeDataSelection: () => {
    const [row, setRow] = useState<(typeof rows)[number] | null>(null)
    const loadMeasurement = useCallback(async (value: (typeof rows)[number] | number) => {
      const next = typeof value === 'number' ? (rows.find((row) => row.id === value) ?? rows[0]) : value
      setRow(next)
      return next
    }, [])
    return {
      measurement: row,
      variables: row?.vars,
      materialSnapshot: row?.material_snapshot,
      loadMeasurement,
      recordedRules: [],
      flatRecordedData: {},
      resultContracts: { result: { visualization: { kind: 'box-grid' } } },
    }
  },
}))
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: (_source: unknown, _change: unknown, options: { candidateVars?: Vars }) => {
    const experimentDocument = useMemo(
      () => ({
        variables: options.candidateVars,
        status: 'Ready',
        revision: 1,
        successfulRevision: 1,
        materialSnapshot: snapshot,
        varsSchema: schema,
        draftTaskNames: [],
        simulationProgram: { resultContracts: {} },
      }),
      [options.candidateVars],
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
  }: {
    experimentDocument: { variables: Vars }
    showToolbar?: boolean
    selectedResult: string
    onSelectedResultChange: (name: string) => void
  }) => (
    <div>
      <output aria-label="Viewer Vars">{JSON.stringify(experimentDocument.variables)}</output>
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
beforeEach(() => {
  vi.clearAllMocks()
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
    await waitFor(() => expect(screen.getByText('후보 생성')).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('후보 생성 방식'), { target: { value: 'empty-lhs' } })
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('후보 생성'))
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
    await waitFor(() => expect(screen.getByText('후보 생성')).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('후보 생성 개수 N'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('후보 생성'))
    await waitFor(() => expect(screen.getByText('선택 Run')).not.toBeDisabled())
    fireEvent.click(screen.getByText('선택 Run'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Calculation failed'))
    expect(screen.getByLabelText('점 선택')).toHaveValue('measurement:1')
    expect(screen.getByText('전체 후보 Run')).toBeDisabled()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
})
