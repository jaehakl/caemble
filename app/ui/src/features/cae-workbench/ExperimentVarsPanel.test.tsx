import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExperimentVarsPanel } from './ExperimentVarsPanel'
import type { CaeWorkbenchState } from './state/useCaeWorkbenchState'

afterEach(() => vi.unstubAllGlobals())

it('preserves the expanded tensor across Candidate revisions and collapses it on a source change', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const workbench = workbenchState()
  workbench.candidateVars = { vector: [1, 3] }
  workbench.experimentDocument = {
    ...workbench.experimentDocument,
    varsSchema: { vector: { shape: [2], min: 0, max: 10 } },
  }
  const { rerender } = render(<ExperimentVarsPanel workbench={workbench} previewing={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'vector tensor 편집' }))
  const editor = screen.getByRole('region', { name: 'vector tensor 상세 편집' })
  const evaluating = {
    ...workbench,
    candidateVars: { vector: [3, 5] },
    experimentSourceValidated: false,
    experimentDocument: { ...workbench.experimentDocument, revision: 5, variables: null },
  }
  rerender(<ExperimentVarsPanel workbench={evaluating} previewing={false} />)
  expect(screen.getByRole('region', { name: 'vector tensor 상세 편집' })).toBe(editor)
  expect(screen.getByLabelText('vector 평균')).toHaveTextContent('평균 4')
  rerender(
    <ExperimentVarsPanel
      workbench={{ ...evaluating, experiment: {} as CaeWorkbenchState['experiment'] }}
      previewing={false}
    />,
  )
  expect(screen.queryByRole('region', { name: 'vector tensor 상세 편집' })).not.toBeInTheDocument()
})

function workbenchState() {
  return {
    workspaceSession: 1,
    candidateVars: { width: 3 },
    experimentSourceValidated: true,
    selectionRestoring: false,
    experimentDocument: {
      varsSchema: { width: { shape: [], min: 0, max: 10 } },
      variables: { width: 1 },
      revision: 4,
      resultSessionKey: 1,
    },
    setCandidateVariables: vi.fn(),
  } as unknown as CaeWorkbenchState
}

it('edits the current Candidate through the shared user-vars pathway', () => {
  const workbench = workbenchState()
  render(<ExperimentVarsPanel workbench={workbench} previewing={false} />)
  const bar = screen.getByRole('slider', { name: 'width' })
  expect(bar).toHaveAttribute('aria-valuenow', '3')
  fireEvent.keyDown(bar, { key: 'End' })
  expect(workbench.setCandidateVariables).toHaveBeenCalledExactlyOnceWith({ width: 10 }, 'user-vars')
})

it('keeps vars editable during reevaluation but invalidates a changed source', () => {
  const workbench = workbenchState()
  const { rerender } = render(<ExperimentVarsPanel workbench={workbench} previewing={false} />)
  const evaluating = {
    ...workbench,
    candidateVars: { width: 8 },
    experimentSourceValidated: false,
    experimentDocument: { ...workbench.experimentDocument, revision: 5, variables: null },
  }
  rerender(<ExperimentVarsPanel workbench={evaluating} previewing={false} />)
  expect(screen.getByRole('slider', { name: 'width' })).toHaveAttribute('aria-disabled', 'false')
  expect(screen.getByRole('slider', { name: 'width' })).toHaveAttribute('aria-valuenow', '8')
  rerender(
    <ExperimentVarsPanel
      workbench={{ ...evaluating, experiment: {} as CaeWorkbenchState['experiment'] }}
      previewing={false}
    />,
  )
  expect(screen.getByRole('slider', { name: 'width' })).toHaveAttribute('aria-disabled', 'true')
})

it.each(['preview', 'restore', 'source', 'session', 'invalid'] as const)('blocks edits for %s', (state) => {
  const workbench = workbenchState()
  if (state === 'restore') workbench.selectionRestoring = true
  if (state === 'source') workbench.experimentSourceValidated = false
  if (state === 'session') workbench.workspaceSession = 2
  if (state === 'invalid') workbench.candidateVars = { width: [3] }
  render(<ExperimentVarsPanel workbench={workbench} previewing={state === 'preview'} />)
  expect(screen.getByRole('status')).toBeVisible()
  const bar = screen.queryByRole('slider', { name: 'width' })
  if (bar) {
    expect(bar).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(bar, { key: 'End' })
  }
  expect(workbench.setCandidateVariables).not.toHaveBeenCalled()
})
