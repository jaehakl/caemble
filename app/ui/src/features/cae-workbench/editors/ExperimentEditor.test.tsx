import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { createCadSourceDocument, createExperimentSourceBundle } from '@caemble/execution/cad/source'
import { ExperimentEditor } from './ExperimentEditor'

vi.mock('@/lib/cad/authoring', () => ({ loadMonaco: () => new Promise(() => {}) }))
vi.mock('@/features/viewer/editor/CadEditor', () => ({ default: () => null }))
vi.mock('./TaskInteractions', () => ({ TaskInteractions: () => null }))

it('offers only Task creation while retaining historical file tabs and removal', () => {
  const handleAddExperimentTask = vi.fn()
  const handleRemoveExperimentFile = vi.fn()
  const controller = {
    sourceReadOnly: false,
    diagnostics: [],
    handleAddExperimentTask,
    handleRemoveExperimentFile,
  } as unknown as CadDocumentController
  const document = createCadSourceDocument(
    'experiment',
    createExperimentSourceBundle({ 'experiment.tsx': '', 'object.ts': 'legacy' }),
  )
  render(<ExperimentEditor controller={controller} document={document} />)
  expect(screen.queryByRole('button', { name: '+ File' })).toBeNull()
  vi.spyOn(window, 'prompt').mockReturnValue('trace')
  fireEvent.click(screen.getByRole('button', { name: '+ Task' }))
  expect(handleAddExperimentTask).toHaveBeenCalledWith('trace', expect.any(String))
  fireEvent.click(screen.getByRole('tab', { name: 'object.ts' }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'File 삭제' }))
  expect(handleRemoveExperimentFile).toHaveBeenCalledWith('object.ts')
})
