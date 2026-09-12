import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { ExperimentPreview } from './ExperimentPreview'

vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: () => <output aria-label="Workbench Viewer">Geometry</output>,
}))

it('renders a local Experiment preview without a saved Experiment ID', () => {
  const workbench = {
    experiment: { sourceBundle: { files: {} } },
    experimentId: null,
    experimentDocument: { resultSessionKey: null },
    selection: { recordedRules: [], loading: false },
    selectionRestoring: false,
    workspaceSession: 1,
  } as unknown as CaeWorkbenchState

  render(<ExperimentPreview workbench={workbench} />)

  expect(screen.getByLabelText('Workbench Viewer')).toHaveTextContent('Geometry')
})
