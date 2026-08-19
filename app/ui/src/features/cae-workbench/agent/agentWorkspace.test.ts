// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createCadSourceDocument } from '@/lib/cad'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { agentGeometryContextVersion } from './agentWorkspace'

const document = createCadSourceDocument('experiment', defaultExperimentSourceBundle)

describe('agentGeometryContextVersion', () => {
  it('is stable for the same Experiment and Geometry drafts', async () => {
    await expect(agentGeometryContextVersion(document)).resolves.toBe(await agentGeometryContextVersion(document))
  })

  it('changes when a local Geometry draft changes', async () => {
    const coordinate = 'caemble:geometry/local/repository/package@local'
    const first = await agentGeometryContextVersion(document, { [coordinate]: { source: 'export const A = 1' } })
    const second = await agentGeometryContextVersion(document, { [coordinate]: { source: 'export const A = 2' } })

    expect(second).not.toBe(first)
  })
})
