import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaeWorkbenchRoute } from './CaeWorkbenchRoute'
import type { AnalysisWorkspaceProps } from '@/features/analysis/AnalysisPage'

const mocks = vi.hoisted(() => ({
  measurement: null as { id: number; recorded_at: string | null } | null,
  viewerMounts: 0,
  viewerProps: {} as Record<string, unknown>,
  isDemo: false,
  manageable: false,
  restoring: false,
  preview: false,
  clearPreview: vi.fn(),
  loadMeasurement: vi.fn(),
  reportError: vi.fn(),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, isPending: false, queryScope: 'guest' }),
}))
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => ({
    experimentId: 7,
    experimentDocument: { resultSessionKey: 'session', materialWarnings: [], draftTaskNames: [] },
    experimentIsDemo: mocks.isDemo,
    experimentManageable: mocks.manageable,
    selectionRestoring: mocks.restoring,
    workspaceSession: {},
    selection: {
      recordedData: {},
      flatRecordedData: { savedMeasurement: 'sentinel', ...(mocks.measurement ? { id: mocks.measurement.id } : {}) },
      recordedSchemas: {},
      recordedRules: {},
      measurement: mocks.measurement,
      loadMeasurement: mocks.loadMeasurement,
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
      return {
        ...layout,
        layout,
        setLayout,
        initialized: true,
        runSafely: (run: () => unknown) => void Promise.resolve().then(run).catch(mocks.reportError),
      }
    },
  }
})
vi.mock('@/features/calculation', () => ({ calculationAccessPolicy: () => ({}) }))
vi.mock('@/features/cae-workbench/useCaePageChrome', () => ({
  useCaePageChrome: ({ preflightControls }: { preflightControls: ReactNode }) => ({
    ribbonPanels: [{ sectionId: 'experiment', content: preflightControls }],
  }),
}))
vi.mock('@/features/cae-workbench/viewer/useSelectionSourceNavigation', () => ({
  useSelectionSourceNavigation: () => ({}),
}))
vi.mock('@/features/cae/CaeBatchProvider', () => ({ useCaeBatches: () => ({ inspectedBatchId: null }) }))
vi.mock('@/features/cae/useCaeBatchConsole', () => ({ useCaeBatchConsole: () => undefined }))
vi.mock('@/lib/cad/model', () => ({ parsePolylineBundles: () => [] }))
vi.mock('@/features/cae-workbench/chrome', () => ({
  WorkbenchRibbonButton: ({
    label,
    onClick,
    disabled,
  }: {
    label: ReactNode
    onClick: () => void
    disabled?: boolean
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
  defaultWorkbenchSections: [
    { id: 'experiment' },
    { id: 'measurement' },
    { id: 'calculation' },
    { id: 'prediction' },
    { id: 'analysis' },
  ],
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
  WorkbenchBottomDock: ({ mode }: { mode: string }) => <output aria-label="Console mode">{mode}</output>,
  WorkbenchConsoleLayout: ({ children, console: consoleContent }: { children: ReactNode; console: ReactNode }) => (
    <>
      {children}
      {consoleContent}
    </>
  ),
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
  AnalysisWorkspace: ({ settingsContainer, onSelectMeasurement, selectedMeasurementId }: AnalysisWorkspaceProps) => (
    <>
      {settingsContainer ? createPortal(<section>Analysis settings</section>, settingsContainer) : null}
      {[41, 42].map((id) => (
        <button key={id} aria-pressed={selectedMeasurementId === id} onClick={() => onSelectMeasurement?.(id)}>
          Measurement #{id}
        </button>
      ))}
    </>
  ),
}))
vi.mock('@/features/measurement/usePreflight', () => ({
  usePreflight: () => {
    const [preview, setPreview] = useState(mocks.preview)
    return {
      busy: false,
      status: '',
      error: null,
      viewerEpoch: 0,
      result: preview ? { experiment: {}, payload: {}, data: { preview: 'sentinel' }, errors: {} } : null,
      clear: () => {
        mocks.clearPreview()
        setPreview(false)
      },
    }
  },
}))
vi.mock('@/features/cae-workbench/dialogs', () => ({ ConfirmWorkbenchDialog: () => null }))
vi.mock('@/features/cae-workbench/editors', () => ({
  ExperimentEditor: () => <div data-testid="experiment-editor" />,
  SourcePathPickerDialog: () => null,
}))
vi.mock('@/features/experiment', () => ({ ExperimentManager: () => null }))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: (props: { autoSelectResult?: boolean }) => {
    mocks.viewerProps = props
    const { autoSelectResult } = props
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
vi.mock('@/features/runtime-console', () => ({
  createRuntimeConsoleStore: () => ({}),
  RuntimeConsoleSummary: () => null,
  RuntimeConsoleView: () => null,
}))
vi.mock('./CalculationWorkbenchContainer', () => ({
  CalculationWorkbenchContainer: ({
    publicDemoMutable,
    measurementSelectionPending,
  }: {
    publicDemoMutable: boolean
    measurementSelectionPending: boolean
  }) => (
    <output aria-label="Calculation context">
      {JSON.stringify({ publicDemoMutable, measurementSelectionPending })}
    </output>
  ),
}))
vi.mock('@/features/cae/CaeBatchPanel', () => ({ CaeBatchPanel: () => null }))
vi.mock('@/features/jobs/JobsPage', () => ({ JobsWorkspace: () => null }))
vi.mock('@/features/launchers/LaunchersPage', () => ({ LaunchersWorkspace: () => null }))
vi.mock('@/features/cae-workbench/CaeWorkbenchDialogs', () => ({ CaeWorkbenchDialogs: () => null }))
vi.mock('@/features/cae-workbench/AdminWorkspace', () => ({ AdminWorkspace: () => null }))
vi.mock('@/features/cae-workbench/WorkbenchDetails', () => ({ ExperimentDetail: () => null }))

beforeEach(() => {
  mocks.measurement = null
  mocks.viewerMounts = 0
  mocks.isDemo = false
  mocks.manageable = false
  mocks.restoring = false
  mocks.preview = false
  mocks.loadMeasurement.mockReset()
})

describe('Workbench section navigation', () => {
  it('fills the Experiment right pane with the Source editor and omits the retired Detail tabs', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CaeWorkbenchRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const sourceWorkspace = screen.getByLabelText('Experiment source workspace')
    expect(sourceWorkspace).toHaveClass('w-full', 'min-w-0', 'flex-1')
    expect(sourceWorkspace).toContainElement(screen.getByTestId('experiment-editor'))
    expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Detail' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Experiment Detail')).not.toBeInTheDocument()
  })

  it('keeps only authoring sections and preserves Prediction state across section changes', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CaeWorkbenchRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText('Console mode')).toHaveTextContent('hidden')
    expect(screen.queryByText('Local editing · 서버 기능은 로그인 필요')).not.toBeInTheDocument()
    for (const retired of ['admin', 'lab', 'help', 'setting']) {
      expect(screen.queryByRole('button', { name: retired })).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'prediction' }))
    await screen.findByLabelText('Candidate variable')
    expect(mocks.viewerProps.recordedData).toBeUndefined()
    expect(mocks.viewerProps.visualizations).toEqual({})
    expect(mocks.viewerProps.resultContracts).toEqual({})
    fireEvent.change(screen.getByLabelText('Candidate variable'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'analysis' }))
    expect(await screen.findByText('Analysis settings')).toBeInTheDocument()
    expect(mocks.viewerProps.recordedData).toEqual({ savedMeasurement: 'sentinel' })
    expect(screen.queryByLabelText('Candidate variable')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'prediction' }))
    await waitFor(() => expect(screen.getByLabelText('Candidate variable')).toHaveValue('11'))
  })
})

describe('Workbench Viewer result updates', () => {
  it.each([41, 42])(
    'loads Analysis Measurement #%s and replaces a temporary preview only after success',
    async (id) => {
      mocks.measurement = { id: 41, recorded_at: null }
      mocks.preview = true
      let finish!: (row: { id: number; recorded_at: null }) => void
      mocks.loadMeasurement.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = (row) => {
              mocks.measurement = row
              resolve(row)
            }
          }),
      )
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <CaeWorkbenchRoute />
          </MemoryRouter>
        </QueryClientProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'analysis' }))
      const point = await screen.findByRole('button', { name: `Measurement #${id}` })
      fireEvent.click(point)
      await waitFor(() => expect(mocks.loadMeasurement).toHaveBeenCalledWith(id, 7))
      expect(screen.getByRole('button', { name: 'Measurement #41' })).toHaveAttribute('aria-pressed', 'true')
      expect(mocks.viewerProps.recordedData).toEqual({ preview: 'sentinel' })
      expect(mocks.clearPreview).not.toHaveBeenCalled()

      await act(async () => finish({ id, recorded_at: null }))
      await waitFor(() => expect(mocks.viewerProps.recordedData).toEqual({ savedMeasurement: 'sentinel', id }))
      expect(mocks.clearPreview).toHaveBeenCalledTimes(1)
      expect(point).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByText('Analysis settings')).toBeInTheDocument()
      expect(mocks.viewerProps.autoSelectResult).toBe(true)
    },
  )

  it.each(['failed', 'superseded'])('retains the selected Measurement and preview for a %s load', async (outcome) => {
    mocks.measurement = { id: 41, recorded_at: null }
    mocks.preview = true
    const error = new Error('Measurement loading failed')
    if (outcome === 'failed') mocks.loadMeasurement.mockRejectedValue(error)
    else mocks.loadMeasurement.mockResolvedValue(null)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CaeWorkbenchRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'analysis' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Measurement #42' }))
    await waitFor(() => expect(mocks.loadMeasurement).toHaveBeenCalledWith(42, 7))
    if (outcome === 'failed') await waitFor(() => expect(mocks.reportError).toHaveBeenCalledWith(error))
    else expect(mocks.reportError).not.toHaveBeenCalled()
    expect(mocks.clearPreview).not.toHaveBeenCalled()
    expect(mocks.viewerProps.recordedData).toEqual({ preview: 'sentinel' })
    expect(screen.getByRole('button', { name: 'Measurement #41' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Measurement #42' })).toHaveAttribute('aria-pressed', 'false')
  })

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

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
] as const)('passes Demo=%s, manageable=%s mutation context and pending restoration', (isDemo, manageable, mutable) => {
  mocks.isDemo = isDemo
  mocks.manageable = manageable
  mocks.restoring = true
  const client = new QueryClient()
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CaeWorkbenchRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'calculation' }))
  expect(JSON.parse(screen.getByLabelText('Calculation context').textContent!)).toEqual({
    publicDemoMutable: mutable,
    measurementSelectionPending: true,
  })
  mocks.restoring = false
  rerender(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CaeWorkbenchRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(JSON.parse(screen.getByLabelText('Calculation context').textContent!)).toEqual({
    publicDemoMutable: mutable,
    measurementSelectionPending: false,
  })
})

it('moves temporary result dismissal into the ribbon without status banners', () => {
  mocks.preview = true
  render(
    <MemoryRouter>
      <CaeWorkbenchRoute />
    </MemoryRouter>,
  )
  expect(screen.queryByText('임시 결과 · 실행 당시 Geometry / Vars')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Experiment source workspace').querySelector('[role="status"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '임시 결과 닫기' }))
  expect(mocks.clearPreview).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: '임시 결과 닫기' })).not.toBeInTheDocument()
})
