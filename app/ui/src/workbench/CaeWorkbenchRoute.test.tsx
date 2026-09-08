import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { CaeWorkbenchRoute } from './CaeWorkbenchRoute'

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, isPending: false, queryScope: 'guest' }),
}))
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => ({
    experimentDocument: {},
    workspaceSession: {},
    selection: { recordedData: {}, flatRecordedData: {}, recordedSchemas: {}, recordedRules: {}, measurement: null },
    selectionContext: { calculationId: null },
    measurementActions: {},
    calculationDataActions: {},
  }),
}))
vi.mock('./useCaePageSession', async () => {
  const { defaultWorkbenchLayoutState } = await import('@/features/cae-workbench/types')
  return {
    useCaePageSession: () => {
      const [layout, setLayout] = useState(defaultWorkbenchLayoutState)
      return { ...layout, setLayout, initialized: true }
    },
  }
})
vi.mock('@/features/calculation', () => ({ calculationAccessPolicy: () => ({}) }))
vi.mock('@/features/cae-workbench/useCaePageChrome', () => ({
  useCaePageChrome: ({ setHelpKind }: { setHelpKind: (kind: string) => void }) => ({
    ribbonPanels: [
      {
        sectionId: 'help',
        content: <button onClick={() => setHelpKind('materials')}>Material Model</button>,
      },
    ],
  }),
}))
vi.mock('@/features/cae-workbench/viewer/useSelectionSourceNavigation', () => ({
  useSelectionSourceNavigation: () => ({}),
}))
vi.mock('@/features/cae/CaeBatchProvider', () => ({ useCaeBatches: () => ({ inspectedBatchId: null }) }))
vi.mock('@/features/cae/useCaeBatchConsole', () => ({ useCaeBatchConsole: () => undefined }))
vi.mock('@/lib/cad/model', () => ({ parseRayPathBundles: () => [] }))
vi.mock('@/features/cae-workbench/chrome', () => ({
  defaultWorkbenchSections: [{ id: 'prediction' }, { id: 'analysis' }, { id: 'lab' }, { id: 'help' }],
  WorkbenchMenubar: ({
    sections,
    onActiveSectionChange,
  }: {
    sections: { id: string }[]
    onActiveSectionChange: (id: string) => void
  }) => (
    <nav>
      {sections.map(({ id }) => (
        <button key={id} onClick={() => onActiveSectionChange(id)}>
          {id}
        </button>
      ))}
    </nav>
  ),
  WorkbenchBottomDock: () => null,
  WorkbenchRibbon: ({
    activeSectionId,
    panels,
  }: {
    activeSectionId: string
    panels: { sectionId: string; content: ReactNode }[]
  }) => panels.find((panel) => panel.sectionId === activeSectionId)?.content ?? null,
}))
vi.mock('./WorkbenchShellContainer', () => ({
  WorkbenchShellContainer: ({
    menubar,
    ribbon,
    left,
    right,
  }: {
    menubar: ReactNode
    ribbon: ReactNode
    left: ReactNode
    right: ReactNode
  }) => (
    <>
      {menubar}
      {ribbon}
      <aside aria-label="Left pane">{left}</aside>
      <aside aria-label="Right pane">{right}</aside>
    </>
  ),
}))
vi.mock('@/features/prediction/PredictionWorkspace', () => ({
  PredictionWorkspace: ({ varsContainer }: { varsContainer: HTMLDivElement | null }) => {
    const [value, setValue] = useState('7')
    return varsContainer
      ? createPortal(
          <section>
            <input aria-label="Candidate variable" value={value} onChange={(event) => setValue(event.target.value)} />
          </section>,
          varsContainer,
        )
      : null
  },
}))
vi.mock('@/features/analysis/AnalysisPage', () => ({
  AnalysisWorkspace: ({ settingsContainer }: { settingsContainer: HTMLDivElement | null }) =>
    settingsContainer ? createPortal(<section>Analysis settings</section>, settingsContainer) : null,
}))
vi.mock('@/features/ai/AiChatPage', () => ({
  AiChatWorkspace: ({ settingsContainer }: { settingsContainer: HTMLDivElement | null }) =>
    settingsContainer ? createPortal(<section>AI settings</section>, settingsContainer) : null,
}))
vi.mock('@/features/cae-workbench/WorkbenchHelp', () => ({
  WorkbenchHelpExplorer: ({
    kind,
    onSelectedItemChange,
  }: {
    kind: string
    onSelectedItemChange: (key: string) => void
  }) => (
    <section>
      <span>{kind}</span>
      <button onClick={() => onSelectedItemChange('test.response@1')}>Select model</button>
    </section>
  ),
  WorkbenchHelpDetail: ({ selectedItem }: { selectedItem: string | null }) => (
    <section>{selectedItem ?? 'Choose model'}</section>
  ),
}))
vi.mock('@/features/cae-workbench/dialogs', () => ({ ConfirmWorkbenchDialog: () => null }))
vi.mock('@/features/cae-workbench/editors', () => ({
  ExperimentEditor: () => null,
  SourcePathPickerDialog: () => null,
}))
vi.mock('@/features/experiment', () => ({ ExperimentManager: () => null }))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({ WorkbenchViewer: () => null }))
vi.mock('@/features/runtime-console', () => ({ createRuntimeConsoleStore: () => ({}), RuntimeConsoleView: () => null }))
vi.mock('@/features/measurement/RayPathSystemCard', () => ({ RayPathSystemCard: () => null }))
vi.mock('./CalculationWorkbenchContainer', () => ({ CalculationWorkbenchContainer: () => null }))
vi.mock('@/features/cae/CaeBatchPanel', () => ({ CaeBatchPanel: () => null }))
vi.mock('@/features/jobs/JobsPage', () => ({ JobsWorkspace: () => null }))
vi.mock('@/features/launchers/LaunchersPage', () => ({ LaunchersWorkspace: () => null }))
vi.mock('@/features/cae-workbench/CaeWorkbenchDialogs', () => ({ CaeWorkbenchDialogs: () => null }))
vi.mock('@/features/cae-workbench/AdminWorkspace', () => ({ AdminWorkspace: () => null }))
vi.mock('@/features/cae-workbench/WorkbenchDetails', () => ({ ExperimentDetail: () => null }))

describe('Workbench portal navigation', () => {
  it('uses Help for Material Model while preserving portal state across section changes', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CaeWorkbenchRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const left = within(screen.getByRole('complementary', { name: 'Left pane' }))
    const right = within(screen.getByRole('complementary', { name: 'Right pane' }))
    expect(screen.queryByRole('button', { name: 'material' })).not.toBeInTheDocument()
    fireEvent.change(await left.findByLabelText('Candidate variable'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Material Model' }))
    expect(await left.findByText('materials')).toBeInTheDocument()
    fireEvent.click(await left.findByRole('button', { name: 'Select model' }))
    expect(right.getByText('test.response@1')).toBeInTheDocument()
    expect(left.queryByLabelText('Candidate variable')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'analysis' }))
    expect(await left.findByText('Analysis settings')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'lab' }))
    expect(await left.findByText('AI settings')).toBeInTheDocument()
    expect(left.queryByText('Analysis settings')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'prediction' }))
    await waitFor(() => expect(left.getByLabelText('Candidate variable')).toHaveValue('11'))
    expect(left.queryByText('AI settings')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'help' }))
    expect(left.getByText('materials')).toBeInTheDocument()
    expect(right.getByText('test.response@1')).toBeInTheDocument()
  })
})
