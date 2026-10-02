import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchViewerProps } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { varsFingerprint } from '@caemble/execution/cad/model/vars'
import { PredictionComparison } from './PredictionComparison'
import { PredictionLayout } from './PredictionLayout'
import type { PredictionViewerState } from './PredictionWorkspace'

const mocks = vi.hoisted(() => ({ viewers: new Map<string, WorkbenchViewerProps>(), cad: vi.fn(), status: 'Ready' }))
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: (source: unknown, _change: unknown, options: { candidateVars: unknown }) => {
    mocks.cad(source, options)
    return {
      experimentDocument: {
        variables: options.candidateVars,
        status: mocks.status,
        revision: 1,
        successfulRevision: 1,
      },
    }
  },
}))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: (props: WorkbenchViewerProps) => {
    const side = props.comparison!.side
    mocks.viewers.set(side, props)
    return (
      <div data-testid={side}>
        <output>{JSON.stringify(props.experimentDocument.variables)}</output>
        <output>{JSON.stringify(props.recordedData)}</output>
        <button onClick={() => props.onSelectedResultChange?.('stress')}>Select stress</button>
        <span>{props.selectedResult}</span>
      </div>
    )
  },
}))
const source = { kind: 'experiment', sourceBundle: { files: {} } }
function state(id: number | null = 1, x = 0.25) {
  return {
    workspaceSession: 1,
    experimentId: 10,
    experiment: source,
    experimentRecord: null,
    candidateVars: { x },
    experimentDocument: { variables: { x }, evaluatedSnapshot: { sourceHash: 'source' } },
    selection: {
      measurement: id ? { id, experiment_id: 10, recorded_at: '2026-09-28' } : null,
      variables: id ? { x } : undefined,
      materialSnapshot: { sourceHash: 'source', varsHash: String(x) },
      loading: false,
      flatRecordedData: id ? { stress: `actual:${id}` } : {},
      visualizations: {},
      resultContracts: {},
      recordedRules: [],
      resultErrors: {},
    },
  } as unknown as CaeWorkbenchState
}
function prediction(x = 0.25) {
  return {
    varsFingerprint: varsFingerprint({ x }),
    sourceHash: 'source',
    preview: { recorded: { stress: 'predicted' }, rules: [], resultContracts: {} },
  } as unknown as PredictionViewerState
}
function view(workbench: CaeWorkbenchState, predicted: PredictionViewerState | null = prediction(), active = true) {
  return (
    <TooltipProvider>
      <PredictionComparison
        key={`${workbench.workspaceSession}:${workbench.experimentId}`}
        workbench={workbench}
        prediction={predicted}
        active={active}
        status="Ready"
      />
    </TooltipProvider>
  )
}
beforeEach(() => {
  mocks.viewers.clear()
  mocks.cad.mockClear()
  mocks.status = 'Ready'
})

it('retains the recorded snapshot through Vars edits, pending selection, failed run and cancellation', () => {
  const initial = state()
  const { rerender } = render(view(initial))
  const actual = screen.getByRole('region', { name: '실제 결과 Viewer' })
  expect(within(actual).getByText('실제 결과 · Measurement #1')).toBeInTheDocument()
  const edited = { ...state(null, 0.8), measurementActions: { busy: true } } as CaeWorkbenchState
  rerender(view(edited, null))
  expect(within(actual).getByText('비교 기준 · 현재 Vars와 다름')).toBeInTheDocument()
  expect(mocks.viewers.get('actual')?.experimentDocument.variables).toEqual({ x: 0.25 })
  expect(mocks.viewers.get('actual')?.recordedData).toEqual({ stress: 'actual:1' })
  expect(mocks.cad).toHaveBeenLastCalledWith(
    source,
    expect.objectContaining({
      resetKey: 1,
      candidateVars: { x: 0.25 },
      persistedMaterialSnapshot: initial.selection.materialSnapshot,
    }),
  )
  const pending = state(2, 0.8)
  rerender(view({ ...pending, selection: { ...pending.selection, loading: true } }, null))
  expect(within(actual).getByText('실제 결과 · Measurement #1')).toBeInTheDocument()
  rerender(view({ ...edited, measurementActions: { busy: false, error: 'cancelled' } } as CaeWorkbenchState, null))
  expect(mocks.viewers.get('actual')?.recordedData).toEqual({ stress: 'actual:1' })
  rerender(view(pending, prediction(0.8)))
  expect(within(actual).getByText('실제 결과 · Measurement #2')).toBeInTheDocument()
  expect(mocks.viewers.get('actual')?.experimentDocument.variables).toEqual({ x: 0.8 })
  expect(mocks.viewers.get('actual')?.recordedData).toEqual({ stress: 'actual:2' })
  expect(mocks.cad).toHaveBeenLastCalledWith(source, expect.objectContaining({ resetKey: 1 }))
})

it('clears an invalidated prediction even when Vars and source are unchanged', () => {
  const initial = state()
  const { rerender } = render(view(initial))
  rerender(view(initial, null))
  expect(mocks.viewers.get('preview')?.recordedData).toBeUndefined()
  rerender(view(state(null, 0.9), null))
  expect(mocks.viewers.get('preview')?.recordedData).toBeUndefined()
  rerender(
    view(
      {
        ...initial,
        experimentDocument: { ...initial.experimentDocument, evaluatedSnapshot: { sourceHash: 'new' } },
      } as CaeWorkbenchState,
      null,
    ),
  )
  expect(mocks.viewers.get('preview')?.recordedData).toBeUndefined()
})

it('shares selection, camera and settings and preserves them across hidden tab updates', () => {
  const initial = state()
  const { rerender } = render(view(initial))
  const camera = mocks.viewers.get('preview')!.comparison!.camera
  const settings = mocks.viewers.get('preview')!.comparison!.settings
  expect(mocks.viewers.get('actual')!.comparison!.camera).toBe(camera)
  expect(mocks.viewers.get('actual')!.comparison!.settings).toBe(settings)
  fireEvent.click(within(screen.getByTestId('preview')).getByRole('button'))
  expect(mocks.viewers.get('actual')?.selectedResult).toBe('stress')
  rerender(view(initial, null, false))
  expect(mocks.viewers.get('preview')?.comparison?.suspended).toBe(true)
  rerender(view(initial))
  expect(mocks.viewers.get('preview')?.selectedResult).toBe('stress')
  expect(mocks.viewers.get('preview')?.comparison?.settings).toBe(settings)
  expect(mocks.viewers.get('preview')?.comparison?.camera).toBe(camera)
})

it('clears on Experiment change and ignores a previous Experiment selection', () => {
  const { rerender } = render(view(state()))
  rerender(view({ ...state(), experimentId: 20, workspaceSession: 2 }, null))
  expect(screen.queryByTestId('actual')).not.toBeInTheDocument()
  expect(screen.getByText('현재 Vars의 예측 결과가 없습니다.')).toBeInTheDocument()
  expect(screen.getByText('Recorded Measurement를 선택하거나 Save & Run을 실행하세요.')).toBeInTheDocument()
})

it('does not attach recorded data to a pending or failed actual geometry', () => {
  mocks.status = 'Evaluating'
  const initial = state()
  const { rerender } = render(view(initial))
  expect(screen.queryByTestId('actual')).not.toBeInTheDocument()
  mocks.status = 'Error'
  rerender(view(initial))
  expect(screen.getByText('실제 결과의 형상을 표시할 수 없습니다.')).toBeInTheDocument()
  expect(screen.queryByTestId('actual')).not.toBeInTheDocument()
})

it('starts with balanced side panes and supports independent keyboard resizing', () => {
  render(<PredictionLayout menubar={null} ribbon={null} vars="Vars" viewer="Viewer" calculations="Calculation" />)
  const left = screen.getByRole('separator', { name: '왼쪽 목록 너비 조절' })
  const right = screen.getByRole('separator', { name: '오른쪽 Detail 너비 조절' })
  expect(left).toHaveAttribute('aria-valuenow', '180')
  expect(right).toHaveAttribute('aria-valuenow', '180')
  fireEvent.keyDown(left, { key: 'ArrowRight' })
  expect(left).toHaveAttribute('aria-valuenow', '184')
  expect(right).toHaveAttribute('aria-valuenow', '180')
})
