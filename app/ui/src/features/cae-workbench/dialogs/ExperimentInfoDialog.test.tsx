import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { ExperimentInfoDialog } from './ExperimentInfoDialog'

function workbenchStub() {
  return {
    experiment: {
      kind: 'experiment',
      sourceBundle: { files: { 'experiment.tsx': '', 'tasks/solve.tsx': '' } },
    },
    experimentCoordinate: 'verified/sample',
    experimentDescription: 'Experiment 설명',
    experimentDirty: true,
    experimentDocument: {
      diagnostics: [{ code: 'TEST', message: '진단 메시지' }],
      status: 'Ready',
    },
    experimentName: 'Sample Experiment',
    experimentRecord: null,
    experimentVersion: null,
    sourceLocked: false,
  } as unknown as CaeWorkbenchState
}

it('shows current Experiment details in a scrollable modal and closes it', () => {
  const onClose = vi.fn()
  render(<ExperimentInfoDialog workbench={workbenchStub()} onClose={onClose} />)

  expect(screen.getByRole('dialog')).toHaveClass('overflow-hidden')
  expect(screen.getByRole('heading', { name: 'Experiment Info' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Sample Experiment' })).toBeInTheDocument()
  expect(screen.getByText('Experiment 설명')).toBeInTheDocument()
  expect(screen.getByText('verified/sample')).toBeInTheDocument()
  expect(screen.getByText('진단 메시지')).toBeInTheDocument()
  expect(screen.queryByText('Experiment Detail')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '닫기' }))
  expect(onClose).toHaveBeenCalledOnce()
})
