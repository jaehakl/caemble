import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaeWorkbenchRoute } from './CaeWorkbenchRoute'

const mocks = vi.hoisted(() => ({
  measurement: null as { id: number; recorded_at: string | null } | null,
  viewerMounts: 0,
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, isPending: false, queryScope: 'guest' }),
}))
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => ({
    experimentDocument: { resultSessionKey: 'session' },
    workspaceSession: {},
    selection: {
      recordedData: {},
      flatRecordedData: {},
      recordedSchemas: {},
      recordedRules: {},
      measurement: mocks.measurement,
    },
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
vi.mock('@/lib/cad/model', () => ({ parsePolylineBundles: () => [] }))
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
    viewer,
    right,
  }: {
    menubar: ReactNode
    ribbon: ReactNode
    left: ReactNode
    viewer: ReactNode
    right: ReactNode
  }) => (
    <>
      {menubar}
      {ribbon}
      <aside aria-label="Left pane">{left}</aside>
      <main>{viewer}</main>
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
vi.mock('@/features/help/HelpWorkspace', () => ({
  HelpWorkspace: ({
    kind,
    item,
    onNavigate,
    onClose,
  }: {
    kind: string
    item: string | null
    onNavigate: (href: string) => void
    onClose: () => void
  }) => (
    <section aria-label="Help workspace">
      <span>{kind}</span>
      <span>{item}</span>
      <button onClick={() => onNavigate('/?help=materials')}>Material Model</button>
      <button onClick={() => onNavigate('/?help=materials&item=test.response%401')}>Select model</button>
      <button onClick={onClose}>Close Help</button>
    </section>
  ),
}))
vi.mock('@/features/cae-workbench/dialogs', () => ({ ConfirmWorkbenchDialog: () => null }))
vi.mock('@/features/cae-workbench/editors', () => ({
  ExperimentEditor: () => null,
  SourcePathPickerDialog: () => null,
}))
vi.mock('@/features/experiment', () => ({ ExperimentManager: () => null }))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: ({ autoSelectResult }: { autoSelectResult?: boolean }) => {
    const [mount] = useState(() => ++mocks.viewerMounts)
    return (
      <div
        data-auto-select-result={String(Boolean(autoSelectResult))}
        data-mount={mount}
        data-testid="workbench-viewer"
      />
    )
  },
}))
vi.mock('@/features/runtime-console', () => ({ createRuntimeConsoleStore: () => ({}), RuntimeConsoleView: () => null }))
vi.mock('./CalculationWorkbenchContainer', () => ({ CalculationWorkbenchContainer: () => null }))
vi.mock('@/features/cae/CaeBatchPanel', () => ({ CaeBatchPanel: () => null }))
vi.mock('@/features/jobs/JobsPage', () => ({ JobsWorkspace: () => null }))
vi.mock('@/features/launchers/LaunchersPage', () => ({ LaunchersWorkspace: () => null }))
vi.mock('@/features/cae-workbench/CaeWorkbenchDialogs', () => ({ CaeWorkbenchDialogs: () => null }))
vi.mock('@/features/cae-workbench/AdminWorkspace', () => ({ AdminWorkspace: () => null }))
vi.mock('@/features/cae-workbench/WorkbenchDetails', () => ({ ExperimentDetail: () => null }))

beforeEach(() => {
  mocks.measurement = null
  mocks.viewerMounts = 0
})

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
    expect(screen.queryByRole('button', { name: 'material' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'prediction' }))
    fireEvent.change(await left.findByLabelText('Candidate variable'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'help' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Material Model' }))
    const help = within(await screen.findByRole('region', { name: 'Help workspace' }))
    expect(await help.findByText('materials')).toBeInTheDocument()
    fireEvent.click(help.getByRole('button', { name: 'Select model' }))
    expect(await help.findByText('test.response@1')).toBeInTheDocument()
    expect(left.getByLabelText('Candidate variable')).toHaveValue('11')
    expect(left.getByLabelText('Candidate variable')).not.toBeVisible()
    fireEvent.click(help.getByRole('button', { name: 'Close Help' }))
    expect(left.getByLabelText('Candidate variable')).toHaveValue('11')
    expect(left.getByLabelText('Candidate variable')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'analysis' }))
    expect(await left.findByText('Analysis settings')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'lab' }))
    expect(await left.findByText('AI settings')).toBeInTheDocument()
    expect(left.queryByText('Analysis settings')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'prediction' }))
    await waitFor(() => expect(left.getByLabelText('Candidate variable')).toHaveValue('11'))
    expect(left.queryByText('AI settings')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'help' }))
    const restored = within(await screen.findByRole('region', { name: 'Help workspace' }))
    expect(await restored.findByText('materials')).toBeInTheDocument()
    expect(restored.getByText('test.response@1')).toBeInTheDocument()
  })
})

describe('Workbench Viewer result updates', () => {
  it('updates selected Measurements through the existing Viewer instance', () => {
    const queryClient = new QueryClient()
    const route = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CaeWorkbenchRoute />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(route())
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-auto-select-result', 'false')
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-mount', '1')

    mocks.measurement = { id: 41, recorded_at: '2026-09-11T00:00:00Z' }
    rerender(route())
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-auto-select-result', 'true')
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-mount', '1')

    mocks.measurement = { id: 42, recorded_at: '2026-09-11T00:01:00Z' }
    rerender(route())
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-auto-select-result', 'true')
    expect(screen.getByTestId('workbench-viewer')).toHaveAttribute('data-mount', '1')
    expect(mocks.viewerMounts).toBe(1)
  })
})
