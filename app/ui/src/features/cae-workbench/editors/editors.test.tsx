// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExperimentSourceDocument } from '@/lib/cad'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { ExperimentEditor } from './ExperimentEditor'
import { RecordedDataEditor } from './RecordedDataEditor'

vi.mock('@/features/viewer/editor/CadEditor', () => ({
  default: ({ modelPath }: { modelPath: string }) => <div data-testid="cad-editor">{modelPath}</div>,
}))

const document: ExperimentSourceDocument = {
  apiVersion: 4,
  formatVersion: 1,
  kind: 'experiment',
  realizationSeed: 1,
  sourceBundle: {
    formatVersion: 1,
    files: {
      'experiment.tsx': 'experiment source',
      'simulate.py': 'simulation source',
      'tasks/zeta.tsx': 'zeta task',
      'tasks/alpha.tsx': 'alpha task',
    },
  },
}

function controller(overrides: Partial<CadDocumentController> = {}) {
  return {
    diagnostics: [],
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ExperimentEditor', () => {
  it('shows required files first, then sorted Task files, and reports file focus', () => {
    const onActiveFileChange = vi.fn()
    render(<ExperimentEditor controller={controller()} document={document} onActiveFileChange={onActiveFileChange} />)

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'experiment.tsx',
      'simulate.py',
      'tasks/alpha.tsx',
      'tasks/zeta.tsx',
    ])

    fireEvent.click(screen.getByRole('tab', { name: 'tasks/alpha.tsx' }))
    expect(onActiveFileChange).toHaveBeenLastCalledWith('tasks/alpha.tsx')
    expect(screen.getByTestId('cad-editor')).toHaveTextContent('file:///tasks/alpha.tsx')
  })

  it('adds and deletes Tasks through the document controller', () => {
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

    fireEvent.click(screen.getByRole('button', { name: '+ Task' }))
    expect(handleAddExperimentTask).toHaveBeenCalledWith('thermal', expect.stringContaining('defineTask'))

    fireEvent.click(screen.getByRole('tab', { name: 'tasks/alpha.tsx' }))
    fireEvent.click(screen.getByRole('button', { name: 'Task 삭제' }))
    expect(handleRemoveExperimentTask).toHaveBeenCalledWith('alpha')
  })
})

describe('RecordedDataEditor', () => {
  it('distinguishes an empty selection from a Measurement without RecordedData', () => {
    const { rerender } = render(<RecordedDataEditor measurementId={null} rules={[]} />)
    expect(screen.getByText('Measurement를 선택하세요')).toBeInTheDocument()

    rerender(<RecordedDataEditor measurementId={7} rules={[]} />)
    expect(screen.getByText('RecordedData가 없습니다')).toBeInTheDocument()
  })
})
