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
      selectSample: vi.fn(),
      selectSetup: vi.fn(),
      loadMeasurement: vi.fn(),
    },
    measurementActions: {
      busy: false,
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/cae']}>
      <CaePage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  currentWorkbench = createWorkbenchState()
  mocks.loadDraft.mockResolvedValue(null)
  mocks.saveDraft.mockResolvedValue(undefined)
  mocks.listMeasurements.mockResolvedValue({ total: 0, items: [] })
})

afterEach(cleanup)

describe('independent CAE workbench page', () => {
  it('registers /cae and renders the desktop-style chrome with exactly eight quick actions', async () => {
    renderPage()

    expect(appRoutePaths).toContain('cae')
    expect(screen.getByRole('menubar', { name: 'CAE 워크벤치 메뉴' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Structure 리본' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'CAE Editor 탭' })).toBeInTheDocument()

    const toolbar = screen.getByRole('toolbar', { name: 'CAE 빠른 작업' })
    expect(within(toolbar).getAllByRole('button')).toHaveLength(8)
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
    ])

    await waitFor(() => expect(screen.getByText('Draft 자동 저장')).toBeInTheDocument())
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
