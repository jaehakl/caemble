import { beforeEach, expect, it, vi } from 'vitest'
import { createCadSourceDocument } from '@/lib/cad/source'
import { saveCadDefinition } from './saveDefinition'

const save = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({ dbTables: { Experiment: { save } } }))

const sourceBundle = { files: { 'experiment.tsx': 'export default null' } }
const calculations = [{ name: '평균', description: '예제', source_code: 'export default () => 1' }]
const common = {
  document: createCadSourceDocument('experiment', sourceBundle),
  savedSourceBundle: sourceBundle,
  records: [],
  resultContracts: {},
  calculations,
  values: { namespace: 'user', repository: 'repo', key: 'copy', name: 'Copy', description: '', bump: 'patch' as const },
}

beforeEach(() => save.mockReset().mockResolvedValue({ id: 42 }))

it('includes example definitions when creating a personal Experiment', async () => {
  await saveCadDefinition({ ...common, mode: 'create', selectedId: null })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mode: 'create', calculations }))
  expect(save.mock.calls[0][0]).not.toHaveProperty('copyCalculationsFromExperimentId')
})

it('copies saved Calculations from the selected Experiment for Save As', async () => {
  await saveCadDefinition({ ...common, mode: 'create', selectedId: 7 })
  expect(save.mock.calls[0][0]).toMatchObject({ mode: 'create', copyCalculationsFromExperimentId: 7 })
  expect(save.mock.calls[0][0]).not.toHaveProperty('calculations')
})

it.each(['overwrite', 'new_version'] as const)('lets the server handle Calculations for %s', async (mode) => {
  await saveCadDefinition({ ...common, mode, selectedId: 7 })
  expect(save.mock.calls[0][0]).toMatchObject({ mode, experimentId: 7 })
  expect(save.mock.calls[0][0]).not.toHaveProperty('calculations')
  expect(save.mock.calls[0][0]).not.toHaveProperty('copyCalculationsFromExperimentId')
})
