// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExperimentSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { DocumentFeedback } from './DocumentFeedback'
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
    renderDiffEditor: vi.fn(),
  }
})

vi.mock('@/lib/cad/authoring', () => ({ loadMonaco: monacoMocks.loadMonaco }))

vi.mock('@/features/viewer/editor/CadEditor', () => ({
  default: (props: { modelPath: string; onAuthoringStateChange?: unknown }) => {
    monacoMocks.renderCadEditor(props)
    return (
      <div data-geometry-ready={monacoMocks.models.has('file:///geometry.tsx')} data-testid="cad-editor">
        {props.modelPath}
      </div>
    )
  },
}))

vi.mock('@/features/viewer/editor/CadDiffEditor', () => ({
  CadDiffEditor: (props: { original: string; modified: string }) => {
    monacoMocks.renderDiffEditor(props)
    return <div data-testid="cad-diff-editor" />
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

  it('exposes Geometry authoring only for Experiment, Geometry, and Task TSX files', async () => {
    const onAuthoringStateChange = vi.fn()
    render(
      <ExperimentEditor
        controller={controller()}
        document={document}
        onAuthoringStateChange={onAuthoringStateChange}
      />,
    )
    await screen.findByTestId('cad-editor')
    expect(monacoMocks.renderCadEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelPath: 'file:///experiment.tsx', onAuthoringStateChange }),
    )

    fireEvent.click(screen.getByRole('tab', { name: 'material.tsx' }))
    expect(monacoMocks.renderCadEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelPath: 'file:///material.tsx', onAuthoringStateChange: undefined }),
    )
    fireEvent.click(screen.getByRole('tab', { name: 'tasks/alpha.tsx' }))
    expect(monacoMocks.renderCadEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelPath: 'file:///tasks/alpha.tsx', onAuthoringStateChange }),
    )
  })

  it('explains that Draft Tasks are preview-only', async () => {
    render(<ExperimentEditor controller={controller({ draftTaskNames: ['main', 'thermal'] })} document={document} />)
    await screen.findByTestId('cad-editor')

    expect(screen.getByText('Draft preview · Solver 미선택')).toBeInTheDocument()
    expect(screen.getByText(/Task: main, thermal/)).toHaveTextContent(
      'Measurement 저장과 CAE 실행은 사용할 수 없습니다.',
    )
  })

  it('opens the Agent change as a diff with line summary and whole-change Undo', async () => {
    const onUndoAgentChange = vi.fn(async () => true)
    render(
      <ExperimentEditor
        agentChange={{
          runId: 'run-1',
          appliedAt: 1,
          status: 'applied',
          files: [
            {
              path: 'experiment.tsx',
              before: 'experiment source',
              after: 'experiment source\nchanged',
              addedLines: 1,
              removedLines: 0,
            },
          ],
        }}
        controller={controller()}
        document={{
          ...document,
          sourceBundle: {
            ...document.sourceBundle,
            files: { ...document.sourceBundle.files, 'experiment.tsx': 'experiment source\nchanged' },
          },
        }}
        onUndoAgentChange={onUndoAgentChange}
      />,
    )

    expect(await screen.findByTestId('cad-diff-editor')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-0')).toBeInTheDocument()
    expect(monacoMocks.renderDiffEditor).toHaveBeenCalledWith(
      expect.objectContaining({ original: 'experiment source', modified: 'experiment source\nchanged' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'AI 변경 전체 Undo' }))
    await waitFor(() => expect(onUndoAgentChange).toHaveBeenCalledOnce())
  })

  it('shows a conflicted Agent result as a read-only staged diff without changing the document', async () => {
    const onUndoAgentChange = vi.fn(async () => true)
    render(
      <ExperimentEditor
        agentChange={{
          runId: 'run-conflict',
          appliedAt: 2,
          status: 'conflicted',
          files: [
            {
              path: 'experiment.tsx',
              before: 'manual source',
              after: 'agent staged source',
              addedLines: 1,
              removedLines: 1,
            },
          ],
        }}
        controller={controller()}
        document={{
          ...document,
          sourceBundle: {
            ...document.sourceBundle,
            files: { ...document.sourceBundle.files, 'experiment.tsx': 'manual source' },
          },
        }}
        onUndoAgentChange={onUndoAgentChange}
      />,
    )

    expect(await screen.findByTestId('cad-diff-editor')).toBeInTheDocument()
    expect(monacoMocks.renderDiffEditor).toHaveBeenCalledWith(
      expect.objectContaining({ original: 'manual source', modified: 'agent staged source', readOnly: true }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'AI staged diff 닫기' }))
    await waitFor(() => expect(onUndoAgentChange).toHaveBeenCalledOnce())
  })
})

describe('DocumentFeedback', () => {
  it('shows the error cause first and keeps the stack collapsed outside the alert', () => {
    render(
      <DocumentFeedback
        controller={controller({
          error: {
            title: 'Experiment Error',
            message: 'vars.openness must be a finite number.',
            stack: 'CadDocumentEvaluationError: vars.openness must be a finite number.\n    at minified.js:241:10849',
          },
        })}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Experiment Error')
    expect(alert).toHaveTextContent('vars.openness must be a finite number.')
    expect(alert).not.toHaveTextContent('at minified.js:241:10849')

    const summary = screen.getByText('Technical details')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByLabelText('Error stack trace')).toHaveTextContent('at minified.js:241:10849')

    fireEvent.click(summary)
    expect(details).toHaveAttribute('open')
  })

  it('omits technical details when the error has no stack', () => {
    render(
      <DocumentFeedback
        controller={controller({
          error: {
            title: 'Measurement Vars Error',
            message: 'The current Measurement is missing vars.openness.',
          },
        })}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('The current Measurement is missing vars.openness.')
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Error stack trace')).not.toBeInTheDocument()
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
