import { describe, expect, it } from 'vitest'
import { experimentTaskPaths } from '@/lib/cad'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'

describe('ExperimentPage source bundle defaults', () => {
  it('starts with Program files and at least one independently named Task', () => {
    expect(defaultExperimentSourceBundle.formatVersion).toBe(1)
    expect(defaultExperimentSourceBundle.files['experiment.tsx']).toContain('experiment({')
    expect(defaultExperimentSourceBundle.files['simulate.py']).toMatch(/^async def simulate\(\*, sim, tasks, vars\):/u)
    expect(experimentTaskPaths(defaultExperimentSourceBundle)).toEqual(['tasks/electric.tsx'])
  })
})
