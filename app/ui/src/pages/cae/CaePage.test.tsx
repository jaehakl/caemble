// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appRoutePaths } from '@/app/router'
import { CaePage } from './CaePage'

const mocks = vi.hoisted(() => ({
  listMeasurements: vi.fn(),
  loadDraft: vi.fn(),
  saveDraft: vi.fn(),
  performMeasurement: vi.fn(),
  openWindow: vi.fn(),
  toastError: vi.fn(),
}))

let currentWorkbench = createWorkbenchState()

vi.mock('@/api', () => ({
  dbTables: {
    Measurement: { listRows: mocks.listMeasurements },
    Structure: { listRows: vi.fn() },
    Experiment: { listRows: vi.fn() },
  },
  getListRequest: () => ({ offset: 0, limit: null }),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 7, display_name: 'CAE Tester', email: 'cae@example.com', roles: ['user'] },
  }),
}))

vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => currentWorkbench,
}))

vi.mock('@/features/cae-workbench/storage/draftStorage', () => ({
  loadWorkbenchDraft: mocks.loadDraft,
  saveWorkbenchDraft: mocks.saveDraft,
  workbenchDraftUserKey: (userId: number | undefined) => `user:${userId ?? 'anonymous'}`,
}))

vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: () => <div>Mock CAD Viewer</div>,
}))

vi.mock('@/features/cae-workbench/editors', () => ({
  StructureEditor: () => <div>Structure source editor</div>,
  ExperimentEditor: () => <div>Experiment source editor</div>,
  RecordedDataEditor: () => <div>RecordedData editor</div>,
}))

vi.mock('@/features/cae-workbench/dialogs', () => ({
  DefinitionLineageSummary: () => null,
  ExamplePickerDialog: () => null,
  DefinitionPickerDialog: () => null,
  HistoryDialog: () => null,
  MeasurementPickerDialog: () => null,
  RealizationPickerDialog: () => null,
  ResearchPickerDialog: () => null,
  ConfirmWorkbenchDialog: ({
    confirmLabel = '계속',
    description,
    onCancel,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel?: string
    description: string
    onCancel: () => void
    onConfirm: () => void
    open: boolean
    title: string
  }) =>
    open ? (
      <div aria-label={title} role="dialog">
        <p>{description}</p>
        <button type="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}))

vi.mock('@/features/viewer/persistence/SaveDefinitionDialog', () => ({
  SaveDefinitionDialog: () => null,
}))

vi.mock('@/pages/analysis/AnalysisPage', () => ({
  AnalysisWorkspace: () => <div>Analysis workspace</div>,
}))

vi.mock('@/pages/materials/MaterialManager', () => ({
  MaterialManager: () => <div>Material manager</div>,
}))

vi.mock('@/pages/account/AccountPage', () => ({ AccountWorkspace: () => <div>Account workspace</div> }))
vi.mock('@/pages/ai/AiChatPage', () => ({ AiChatWorkspace: () => <div>AI Chat workspace</div> }))
vi.mock('@/pages/ai/AiHelperPage', () => ({
  AiHelperWorkspace: ({
    activeExperimentFile,
    activeTab,
    workbench,
  }: {
    activeExperimentFile: string | null
    activeTab: string
    workbench: { structureName: string }
  }) => <div>{`AI Helper workspace: ${activeTab}:${activeExperimentFile}:${workbench.structureName}`}</div>,
}))
vi.mock('@/pages/jobs/JobsPage', () => ({ JobsWorkspace: () => <div>Jobs workspace</div> }))
vi.mock('@/pages/launchers/LaunchersPage', () => ({ LaunchersWorkspace: () => <div>Launchers workspace</div> }))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}))

function createWorkbenchState() {
  const structureDocument = {
    handleReroll: vi.fn(),
    runIsBusy: false,
  }
  const experimentDocument = {
    handleReroll: vi.fn(),
    runIsBusy: false,
  }
  return {
    structure: { kind: 'structure', source: 'export default function structure() {}' },
    experiment: {
      kind: 'experiment',
      sourceBundle: {
        experimentCode: 'export default function experiment() {}',
        simulationCode: 'async def simulate():\n    pass',
        tasks: [{ name: 'Task', code: 'export default function task() {}' }],
      },
    },
    structureRecord: { id: 10, user_id: 7, name: 'Beam' },
    experimentRecord: { id: 20, user_id: 7, name: 'Compression' },
    structureId: 10,
    experimentId: 20,
    structureName: 'Beam',
    structureDescription: '',
    experimentName: 'Compression',
    experimentDescription: '',
    structureDirty: false,
    experimentDirty: false,
    pairDirty: false,
    pairClean: true,
    structureClean: true,
    experimentClean: true,
    structureStatus: 'saved',
    experimentStatus: 'saved',
    structureManageable: true,
    experimentManageable: true,
    saving: null,
    selection: {
      sample: null,
      setup: null,
      measurement: null,
      recordedData: null,
      recordedRules: [],
      clearAll: vi.fn(),
      clearMeasurement: vi.fn(),
      clearSample: vi.fn(),
      clearSetup: vi.fn(),
      selectSample: vi.fn(),
      selectSetup: vi.fn(),
      loadMeasurement: vi.fn(),
    },
    measurementActions: {
      busy: false,
      cancelable: false,
      operation: null as 'sample' | 'setup' | 'measurement' | null,
      stage: 'idle',
      cancel: vi.fn(),
      generateSample: vi.fn(),
      generateSetup: vi.fn(),
      performMeasurement: mocks.performMeasurement,
      generateMeasurement: vi.fn(),
    },
    structureDocument,
    experimentDocument,
    simulation: {},
    applyStructure: vi.fn(),
    applyExperiment: vi.fn(),
    loadStructure: vi.fn(),
    loadExperiment: vi.fn(),
    loadResearch: vi.fn(),
    restoreSelection: vi.fn(),
    newStructure: vi.fn(),
    newExperiment: vi.fn(),
    newResearch: vi.fn(),
    saveStructure: vi.fn(),
    saveExperiment: vi.fn(),
    restoreDraft: vi.fn(),
    draft: vi.fn(() => ({})),
  }
}

function renderPage(entry = '/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <CaePage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'open').mockImplementation(mocks.openWindow)
  currentWorkbench = createWorkbenchState()
  mocks.loadDraft.mockResolvedValue(null)
  mocks.saveDraft.mockResolvedValue(undefined)
  mocks.listMeasurements.mockResolvedValue({ total: 0, items: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('root CAE workbench page', () => {
  it.each(['/#viewer', '/#help'])('renders Not Found for the removed legacy hash %s', (entry) => {
    renderPage(entry)

    expect(screen.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeInTheDocument()
    expect(screen.queryByRole('menubar', { name: 'CAE 워크벤치 메뉴' })).not.toBeInTheDocument()
  })

  it('registers Workbench and docs routes and renders the desktop-style chrome with exactly ten quick actions', async () => {
    renderPage()

    expect(appRoutePaths).toEqual(['index', 'docs', '*'])
    expect(screen.getByRole('menubar', { name: 'CAE 워크벤치 메뉴' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Structure 리본' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'CAE Editor 탭' })).toBeInTheDocument()

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    expect(within(toolbar).getAllByRole('button')).toHaveLength(10)
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')?.split(':')[0]),
    ).toEqual([
      'New Research',
      'Load Research',
      'Save Structure',
      'Save Experiment',
      'Generate Sample',
      'Generate Setup',
      'Perform Measurement',
      'Generate Measurement',
      'Launchers',
      'Jobs',
    ])

    await waitFor(() => expect(screen.getByText('Draft 자동 저장')).toBeInTheDocument())
  })

  it('opens the same Launchers and Jobs workspaces from Settings and the Toolbar', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
    await user.click(screen.getByRole('menuitem', { name: 'Launchers' }))
    expect(await screen.findByText('Launchers workspace')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Launchers' })).toContainElement(screen.getByText('Launchers workspace'))
    await user.click(screen.getByRole('button', { name: '닫기' }))

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    await user.click(within(toolbar).getByRole('button', { name: 'Launchers' }))
    expect(await screen.findByText('Launchers workspace')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '닫기' }))

    await user.click(within(toolbar).getByRole('button', { name: 'Jobs' }))
    expect(await screen.findByText('Jobs workspace')).toBeInTheDocument()
  })

  it('preserves Lab AI Chat and opens AI Helper with the focused Workbench context', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('menuitem', { name: 'Lab' }))
    await user.click(screen.getByRole('menuitem', { name: 'AI Chat' }))
    expect(await screen.findByText('AI Chat workspace')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '닫기' }))

    await user.click(screen.getByRole('menuitem', { name: 'Help' }))
    await user.click(screen.getByRole('menuitem', { name: 'AI Helper' }))
    const helperDialog = await screen.findByRole('dialog', { name: 'AI Helper' })
    expect(helperDialog).toContainElement(await screen.findByText('AI Helper workspace: structure:experiment.tsx:Beam'))
    expect(mocks.openWindow).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '닫기' }))
  })

  it('opens every Help document entry in a new window', async () => {
    const user = userEvent.setup()
    renderPage()

    for (const [label, url] of [
      ['Manual', '/docs?section=program'],
      ['Geometry Catalog', '/docs?section=geometry'],
      ['Material Catalog', '/docs?section=materials'],
      ['Quantity Catalog', '/docs?section=quantity-kinds'],
      ['Physics Catalog', '/docs?section=solvers'],
    ]) {
      await user.click(screen.getByRole('menuitem', { name: 'Help' }))
      await user.click(screen.getByRole('menuitem', { name: label }))
      expect(mocks.openWindow).toHaveBeenLastCalledWith(url, '_blank', 'noopener,noreferrer')
    }

    expect(mocks.openWindow).toHaveBeenCalledTimes(5)
    expect(screen.queryByRole('dialog', { name: /Manual|Catalog/ })).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('disables source-dependent Data actions while Structure has unsaved edits', () => {
    currentWorkbench.structureDirty = true
    currentWorkbench.pairDirty = true
    currentWorkbench.structureClean = false
    currentWorkbench.pairClean = false

    renderPage()

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    expect(within(toolbar).getByRole('button', { name: /Generate Sample:/ })).toHaveAttribute('aria-disabled', 'true')
    expect(within(toolbar).getByRole('button', { name: /Perform Measurement:/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(toolbar).getByRole('button', { name: /Generate Measurement:/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(toolbar).getByRole('button', { name: 'Generate Setup' })).not.toHaveAttribute('aria-disabled')
  })

  it('clears persisted realization selections before manually rerolling each definition', async () => {
    const user = userEvent.setup()
    currentWorkbench.selection.sample = { id: 11 } as never
    currentWorkbench.selection.setup = { id: 22 } as never
    currentWorkbench.selection.measurement = { id: 33 } as never
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Reroll' }))
    expect(currentWorkbench.selection.clearSample).toHaveBeenCalledOnce()
    expect(currentWorkbench.structureDocument.handleReroll).toHaveBeenCalledOnce()
    expect(currentWorkbench.selection.clearSample.mock.invocationCallOrder[0]).toBeLessThan(
      currentWorkbench.structureDocument.handleReroll.mock.invocationCallOrder[0],
    )

    await user.click(screen.getByRole('tab', { name: 'Experiment' }))
    await user.click(screen.getByRole('button', { name: 'Reroll' }))
    expect(currentWorkbench.selection.clearSetup).toHaveBeenCalledOnce()
    expect(currentWorkbench.experimentDocument.handleReroll).toHaveBeenCalledOnce()
  })

  it('turns the Toolbar Perform Measurement action into Cancel during a cancellable measurement run', async () => {
    const user = userEvent.setup()
    currentWorkbench.measurementActions.busy = true
    currentWorkbench.measurementActions.cancelable = true
    currentWorkbench.measurementActions.operation = 'measurement'
    currentWorkbench.measurementActions.stage = 'CAE 실행 중'
    renderPage()

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    await user.click(within(toolbar).getByRole('button', { name: 'Cancel Measurement' }))
    expect(currentWorkbench.measurementActions.cancel).toHaveBeenCalledOnce()
    expect(within(toolbar).queryByRole('button', { name: 'Perform Measurement' })).not.toBeInTheDocument()
  })

  it('keeps measurement cancellation disabled while the Measurement is being saved', () => {
    currentWorkbench.selection.sample = { id: 11 } as never
    currentWorkbench.selection.setup = { id: 22 } as never
    currentWorkbench.measurementActions.busy = true
    currentWorkbench.measurementActions.cancelable = false
    currentWorkbench.measurementActions.operation = 'measurement'
    currentWorkbench.measurementActions.stage = 'Measurement 저장 중'
    renderPage()

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    expect(within(toolbar).getByRole('button', { name: /Perform Measurement:/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(toolbar).queryByRole('button', { name: 'Cancel Measurement' })).not.toBeInTheDocument()
  })

  it('reopens a closed editor tab from the View menu', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Structure 탭 닫기' }))
    expect(screen.queryByRole('tab', { name: 'Structure' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'View' }))
    await user.click(screen.getByRole('menuitem', { name: 'Structure Editor' }))

    expect(screen.getByRole('tab', { name: 'Structure' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Structure source editor')
  })

  it('asks before overwriting an existing Measurement for the selected Sample and Setup', async () => {
    const user = userEvent.setup()
    currentWorkbench.selection.sample = { id: 11 } as never
    currentWorkbench.selection.setup = { id: 22 } as never
    currentWorkbench.selection.measurement = { id: 33, sample_id: 11, setup_id: 22 } as never
    mocks.listMeasurements.mockResolvedValue({ total: 1, items: [{ id: 33 }] })
    renderPage()

    await user.click(
      screen
        .getByRole('toolbar', { name: 'CAE 빠른 작업' })
        .querySelector('button[aria-label="Perform Measurement"]') as HTMLButtonElement,
    )

    const confirmation = await screen.findByRole('dialog', { name: '기존 Measurement를 덮어쓸까요?' })
    expect(confirmation).toHaveTextContent('Sample #11 + Setup #22')
    expect(mocks.performMeasurement).not.toHaveBeenCalled()

    await user.click(within(confirmation).getByRole('button', { name: '실행하고 덮어쓰기' }))
    expect(mocks.performMeasurement).toHaveBeenCalledWith(true, { sampleId: 11, setupId: 22 })
  })

  it('starts a fresh Measurement with overwrite disabled and fixed selection IDs', async () => {
    const user = userEvent.setup()
    currentWorkbench.selection.sample = { id: 11 } as never
    currentWorkbench.selection.setup = { id: 22 } as never
    renderPage()

    await user.click(
      screen
        .getByRole('toolbar', { name: 'CAE 빠른 작업' })
        .querySelector('button[aria-label="Perform Measurement"]') as HTMLButtonElement,
    )

    await waitFor(() => expect(mocks.performMeasurement).toHaveBeenCalledWith(false, { sampleId: 11, setupId: 22 }))
    expect(screen.queryByRole('dialog', { name: '기존 Measurement를 덮어쓸까요?' })).not.toBeInTheDocument()
  })

  it('does not run when the Sample or Setup changes during overwrite preflight', async () => {
    const user = userEvent.setup()
    let resolveMeasurements!: (value: { total: number; items: never[] }) => void
    mocks.listMeasurements.mockReturnValue(
      new Promise((resolve) => {
        resolveMeasurements = resolve
      }),
    )
    currentWorkbench.selection.sample = { id: 11 } as never
    currentWorkbench.selection.setup = { id: 22 } as never
    renderPage()

    await user.click(
      screen
        .getByRole('toolbar', { name: 'CAE 빠른 작업' })
        .querySelector('button[aria-label="Perform Measurement"]') as HTMLButtonElement,
    )
    await waitFor(() => expect(mocks.listMeasurements).toHaveBeenCalledOnce())
    currentWorkbench.selection.sample = { id: 12 } as never
    resolveMeasurements({ total: 0, items: [] })

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Measurement 확인 중 Sample 또는 Setup 선택이 바뀌었습니다. 다시 실행하세요.',
      ),
    )
    expect(mocks.performMeasurement).not.toHaveBeenCalled()
  })
})
