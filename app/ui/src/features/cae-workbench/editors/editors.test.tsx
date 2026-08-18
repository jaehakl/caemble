// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExperimentSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { ExperimentEditor } from './ExperimentEditor'
import { RecordedDataEditor } from './RecordedDataEditor'

const monacoMocks = vi.hoisted(() => {
  const models = new Map<
    string,
    {
      dispose: ReturnType<typeof vi.fn>
      getValue: ReturnType<typeof vi.fn>
      language: string
      setValue: ReturnType<typeof vi.fn>
      uri: { toString: () => string }
    }
  >()
  const parse = vi.fn((value: string) => ({ toString: () => value }))
  const createModel = vi.fn((initialValue: string, language: string, uri: { toString: () => string }) => {
    let value = initialValue
    const key = uri.toString()
    const model = {
      dispose: vi.fn(() => {
        if (models.get(key) === model) models.delete(key)
      }),
      getValue: vi.fn(() => value),
      language,
      setValue: vi.fn((next: string) => {
        value = next
      }),
      uri,
    }
    models.set(key, model)
    return model
  })
  const getModel = vi.fn((uri: { toString: () => string }) => models.get(uri.toString()) ?? null)
  return {
    createModel,
    getModel,
    loadMonaco: vi.fn(async () => ({
      Uri: { parse },
      editor: { createModel, getModel, setModelMarkers: vi.fn() },
    })),
    models,
    renderCadEditor: vi.fn(),
  }
})

vi.mock('@/lib/cad/authoring', () => ({ loadMonaco: monacoMocks.loadMonaco }))

vi.mock('@/features/viewer/editor/CadEditor', () => ({
  default: ({ modelPath }: { modelPath: string }) => {
    monacoMocks.renderCadEditor(modelPath)
    return (
      <div data-geometry-ready={monacoMocks.models.has('file:///geometry.tsx')} data-testid="cad-editor">
        {modelPath}
      </div>
    )
  },
}))

const document: ExperimentSourceDocument = {
  apiVersion: 7,
  formatVersion: 2,
  kind: 'experiment',
  sourceBundle: {
    formatVersion: 5,
    files: {
      'experiment.tsx': 'experiment source',
      'geometry.tsx': 'export {}',
      'material.tsx': 'export {}',
      'simulate.py': 'simulation source',
      'tasks/zeta.tsx': 'zeta task',
      'tasks/alpha.tsx': 'alpha task',
    },
    geometrySnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
  },
}

function controller(overrides: Partial<CadDocumentController> = {}) {
  return {
    diagnostics: [],
    draftTaskNames: [],
    error: null,
    handleAddExperimentTask: vi.fn(),
    handleExperimentFileChange: vi.fn(),
    handleRemoveExperimentTask: vi.fn(),
    materialWarnings: [],
    sourceReadOnly: false,
    status: 'Ready',
    ...overrides,
  } as CadDocumentController
}

beforeEach(() => {
  monacoMocks.models.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ExperimentEditor', () => {
  it('registers every bundle model before showing required files and reports file focus', async () => {
    const onActiveFileChange = vi.fn()
    render(<ExperimentEditor controller={controller()} document={document} onActiveFileChange={onActiveFileChange} />)

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'simulate.py',
      'tasks/alpha.tsx',
      'tasks/zeta.tsx',
    ])
    expect(await screen.findByTestId('cad-editor')).toHaveAttribute('data-geometry-ready', 'true')
    expect([...monacoMocks.models.keys()].sort()).toEqual([
      'file:///experiment.tsx',
      'file:///geometry.tsx',
      'file:///material.tsx',
      'file:///simulate.py',
      'file:///tasks/alpha.tsx',
      'file:///tasks/zeta.tsx',
    ])

    fireEvent.click(screen.getByRole('tab', { name: 'tasks/alpha.tsx' }))
    expect(onActiveFileChange).toHaveBeenLastCalledWith('tasks/alpha.tsx')
    expect(await screen.findByTestId('cad-editor')).toHaveTextContent('file:///tasks/alpha.tsx')
  })

  it('synchronizes inactive models, removes deleted files, and disposes the session', async () => {
    const { rerender, unmount } = render(<ExperimentEditor controller={controller()} document={document} />)
    await screen.findByTestId('cad-editor')
    const geometryModel = monacoMocks.models.get('file:///geometry.tsx')!
    const removedTaskModel = monacoMocks.models.get('file:///tasks/alpha.tsx')!
    const remainingFiles = { ...document.sourceBundle.files }
    delete remainingFiles['tasks/alpha.tsx']
    const nextDocument = {
      ...document,
      sourceBundle: {
        ...document.sourceBundle,
        files: {
          ...remainingFiles,
          'geometry.tsx': 'export const Updated = () => <box />',
          'tasks/thermal.tsx': 'thermal task',
        },
      },
    }

    rerender(<ExperimentEditor controller={controller()} document={nextDocument} />)
    await waitFor(() => expect(geometryModel.getValue()).toBe('export const Updated = () => <box />'))
    expect(removedTaskModel.dispose).toHaveBeenCalledOnce()
    expect(monacoMocks.models.has('file:///tasks/thermal.tsx')).toBe(true)

    unmount()
    expect(geometryModel.dispose).toHaveBeenCalledOnce()
    expect(monacoMocks.models.size).toBe(0)
  })

  it('adds and deletes Tasks through the document controller', async () => {
    const handleAddExperimentTask = vi.fn()
    const handleRemoveExperimentTask = vi.fn()
    vi.spyOn(window, 'prompt').mockReturnValue('thermal')
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <ExperimentEditor
        controller={controller({ handleAddExperimentTask, handleRemoveExperimentTask })}
        document={document}
      />,
    )
    await screen.findByTestId('cad-editor')

    fireEvent.click(screen.getByRole('button', { name: '+ Task' }))
    expect(handleAddExperimentTask).toHaveBeenCalledWith('thermal', expect.stringContaining('defineTask'))

    fireEvent.click(screen.getByRole('tab', { name: 'tasks/alpha.tsx' }))
    fireEvent.click(screen.getByRole('button', { name: 'Task 삭제' }))
    expect(handleRemoveExperimentTask).toHaveBeenCalledWith('alpha')
  })

  it('explains that Draft Tasks are preview-only', async () => {
    render(<ExperimentEditor controller={controller({ draftTaskNames: ['main', 'thermal'] })} document={document} />)
    await screen.findByTestId('cad-editor')

    expect(screen.getByText('Draft preview · Solver 미선택')).toBeInTheDocument()
    expect(screen.getByText(/Task: main, thermal/)).toHaveTextContent(
      'Measurement 저장과 CAE 실행은 사용할 수 없습니다.',
    )
  })
})

describe('RecordedDataEditor', () => {
  it('distinguishes an empty selection from a Measurement without RecordedData', () => {
    const { rerender } = render(<RecordedDataEditor measurementId={null} recordedAt={null} rules={[]} />)
    expect(screen.getByText('Measurement를 선택하세요')).toBeInTheDocument()

    rerender(<RecordedDataEditor measurementId={7} recordedAt={null} rules={[]} />)
    expect(screen.getByText('실행되지 않은 Measurement입니다')).toBeInTheDocument()

    rerender(<RecordedDataEditor measurementId={7} recordedAt="2026-08-12T00:00:00Z" rules={[]} />)
    expect(screen.getByText('RecordedData가 없습니다')).toBeInTheDocument()

    rerender(<RecordedDataEditor measurementId={7} pendingSave recordedAt={null} rules={[]} />)
    expect(screen.getByText('세션 결과 저장을 다시 시도하세요')).toBeInTheDocument()
  })
})
