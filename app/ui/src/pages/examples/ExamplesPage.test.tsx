// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadSource, updateCadSource, type CadSourceDocument } from '@/lib/cad'
import { caembleProgramExamples } from '@/lib/examples'
import { ExamplesPage } from './ExamplesPage'

const workspace = vi.hoisted(() => ({
  experimentRenderEnd: vi.fn(),
  experimentRenderError: vi.fn(),
  experimentRenderStart: vi.fn(),
  run: vi.fn(),
  structureRenderEnd: vi.fn(),
  structureRenderError: vi.fn(),
  structureRenderStart: vi.fn(),
  useCadWorkspace: vi.fn(),
}))

const clipboard = vi.hoisted(() => ({
  writeText: vi.fn(),
}))

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))
const NativeRequest = globalThis.Request

vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: workspace.useCadWorkspace,
}))

vi.mock('@/features/viewer/workspace/StructureExperimentViewer', () => ({
  StructureExperimentViewer: ({
    experiment,
    experimentDocument,
    onActiveDocumentTypeChange,
    structure,
    structureDocument,
  }: {
    experiment: CadSourceDocument
    experimentDocument: { handleSourceChange: (source: string) => void }
    onActiveDocumentTypeChange: (documentType: 'structure' | 'experiment') => void
    structure: CadSourceDocument
    structureDocument: { handleSourceChange: (source: string) => void }
  }) => (
    <div>
      <div data-testid="structure-source">{cadSource(structure)}</div>
      <div data-testid="experiment-source">{cadSource(experiment)}</div>
      <button type="button" onClick={() => structureDocument.handleSourceChange('changed structure source')}>
        Structure 편집
      </button>
      <button type="button" onClick={() => experimentDocument.handleSourceChange('changed experiment source')}>
        Experiment 편집
      </button>
      <button type="button" onClick={() => onActiveDocumentTypeChange('experiment')}>
        Experiment 활성화
      </button>
    </div>
  ),
}))

vi.mock('@/features/viewer/viewer/CadViewer', () => ({
  default: ({
    children,
    simulation,
  }: {
    children?: ReactNode
    simulation: {
      program?: unknown
      run: () => string | null
    }
  }) => (
    <div>
      <div data-testid="program-manifest">{simulation.program ? 'v3 program connected' : 'no program'}</div>
      <button type="button" onClick={simulation.run}>
        Mock Run Simulation
      </button>
      {children}
    </div>
  ),
}))

vi.mock('sonner', () => ({
  toast: notifications,
}))

function renderPage(path = '/examples') {
  const router = createMemoryRouter(
    [
      { path: '/examples/:exampleId?', Component: ExamplesPage },
      { path: '/docs', element: <div>Docs</div> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined })
      }
    },
  )
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard.writeText },
  })
  clipboard.writeText.mockResolvedValue(undefined)
  workspace.run.mockReturnValue('example-run')
  workspace.useCadWorkspace.mockImplementation(
    (
      structure: CadSourceDocument,
      experiment: CadSourceDocument,
      onStructureChange: (document: CadSourceDocument) => void,
      onExperimentChange: (document: CadSourceDocument) => void,
    ) => ({
      structureDocument: {
        handleRenderEnd: workspace.structureRenderEnd,
        handleRenderError: workspace.structureRenderError,
        handleRenderStart: workspace.structureRenderStart,
        handleSourceChange: (source: string) => onStructureChange(updateCadSource(structure, source)),
        scene: { lengthUnit: 'mm', parts: [] },
        sceneHash: 'structure-scene',
        selection: null,
        variables: {},
      },
      experimentDocument: {
        handleRenderEnd: workspace.experimentRenderEnd,
        handleRenderError: workspace.experimentRenderError,
        handleRenderStart: workspace.experimentRenderStart,
        handleSourceChange: (source: string) => onExperimentChange(updateCadSource(experiment, source)),
        scene: { lengthUnit: 'mm', parts: [] },
        sceneHash: 'experiment-scene',
        selection: null,
        simulationProgram: {
          formatVersion: 1,
          programHash: 'example-program',
          tasks: {
            solveCurrent: {
              kernel: { name: 'dc-current-density', version: '0.0.0' },
              configHash: 'example-config',
            },
          },
          recordedData: {
            totalCurrent: {
              dtype: 'float64',
              unit: 'A',
              quantityKind: 'electromagnetism.ElectricCurrent',
            },
          },
        },
        variables: {},
      },
      simulation: {
        canRun: true,
        cancel: vi.fn(),
        compatibility: { status: 'compatible', issues: [] },
        exportProgramResult: () => null,
        process: {
          runId: null,
          status: 'idle',
          engine: null,
          stage: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        },
        programResult: null,
        recordedData: null,
        run: workspace.run,
        stale: false,
      },
    }),
  )
})

afterAll(() => vi.unstubAllGlobals())
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ExamplesPage', () => {
  it('canonicalizes the default route and loads both verified sources', async () => {
    const router = renderPage()
    const example = caembleProgramExamples[0]

    await waitFor(() => expect(router.state.location.pathname).toBe(`/examples/${example.id}`))
    expect(screen.getByRole('heading', { name: example.title })).toBeInTheDocument()
    expect(screen.getByTestId('structure-source')).toHaveTextContent('structure({')
    expect(screen.getByTestId('experiment-source')).toHaveTextContent('dcCurrentDensity({')
    expect(screen.getByTestId('program-manifest')).toHaveTextContent('v3 program connected')

    await userEvent.click(screen.getByRole('button', { name: 'Mock Run Simulation' }))
    expect(workspace.run).toHaveBeenCalledOnce()
  })

  it('edits, copies, and resets a session-local source pair', async () => {
    renderPage('/examples/dc-uniform-bar')

    await userEvent.click(screen.getByRole('button', { name: 'Structure 편집' }))
    expect(screen.getByText('수정됨')).toBeInTheDocument()
    expect(screen.getByTestId('structure-source')).toHaveTextContent('changed structure source')

    await userEvent.click(screen.getByRole('button', { name: 'Structure 복사' }))
    expect(clipboard.writeText).toHaveBeenCalledWith('changed structure source')
    expect(notifications.success).toHaveBeenCalledWith('Structure Source를 복사했습니다.')

    await userEvent.click(screen.getByRole('button', { name: '전체 예제 초기화' }))
    expect(screen.queryByText('수정됨')).not.toBeInTheDocument()
    expect(screen.getByTestId('structure-source')).toHaveTextContent('structure({')
  })

  it('confirms before discarding edits when another example is selected', async () => {
    const router = renderPage('/examples/dc-uniform-bar')
    const select = screen.getByLabelText('Experiment Program 예제 선택')

    await userEvent.click(screen.getByRole('button', { name: 'Experiment 편집' }))
    fireEvent.change(select, { target: { value: 'dc-resolution-study' } })

    expect(screen.getByRole('dialog', { name: '수정한 예제를 바꿀까요?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '계속 편집' }))
    expect(router.state.location.pathname).toBe('/examples/dc-uniform-bar')

    fireEvent.change(select, { target: { value: 'dc-resolution-study' } })
    await userEvent.click(screen.getByRole('button', { name: '변경 버리고 이동' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/examples/dc-resolution-study'))
    expect(screen.getByRole('heading', { name: 'DC Resolution Study' })).toBeInTheDocument()
    expect(screen.queryByText('수정됨')).not.toBeInTheDocument()
    expect(screen.getByTestId('experiment-source')).toHaveTextContent('solveCoarse')
  })
})
