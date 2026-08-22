// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createCadSourceDocument } from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { agentExperimentContextVersion } from './agentWorkspace'

const document = createCadSourceDocument('experiment', starterExperimentSourceBundle)

describe('agentExperimentContextVersion', () => {
  it('is stable for the same Experiment source bundle', async () => {
    await expect(agentExperimentContextVersion(document)).resolves.toBe(await agentExperimentContextVersion(document))
  })

  it('changes when a bundle-local source file changes', async () => {
    const changedDocument = createCadSourceDocument('experiment', {
      ...starterExperimentSourceBundle,
      files: { ...starterExperimentSourceBundle.files, 'geometry.tsx': 'export const A = 2' },
    })
    const first = await agentExperimentContextVersion(document)
    const second = await agentExperimentContextVersion(changedDocument)

    expect(second).not.toBe(first)
  })
})
