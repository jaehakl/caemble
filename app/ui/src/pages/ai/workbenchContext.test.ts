import { describe, expect, it } from 'vitest'
import { WORKBENCH_REFERENCE_MAX_BYTES, buildWorkbenchReferenceContext } from './workbenchContext'

describe('buildWorkbenchReferenceContext', () => {
  it('includes one Experiment source bundle and prepared/recorded selection state', () => {
    const result = buildWorkbenchReferenceContext({
      focus: { activeTab: 'experiment', activeExperimentFile: 'tasks/thermal.tsx' },
      experiment: {
        files: {
          'experiment.tsx': 'export default experiment({})',
          'tasks/thermal.tsx': 'export default defineTask({})',
          'simulate.py': 'async def simulate(*, sim, tasks, vars): pass',
        },
        dirty: false,
        revision: 3,
        successfulRevision: 3,
        status: 'Ready',
        evaluation: {
          revision: 3,
          vars: { width: 2 },
          varsSchema: { width: { min: 1, max: 4 } },
          materialWarnings: [],
        },
      },
      selection: {
        measurement: { id: 11, state: 'prepared', selected: true, applied: true, recorded: false },
      },
      run: { operation: null, status: 'idle' },
    })

    expect(result.text).toContain('export default experiment')
    expect(result.text).toContain('tasks/thermal.tsx')
    expect(result.text).toContain('"recorded": false')
    expect(result.text).not.toContain('Structure source')
    expect(result.text).not.toContain('sample')
    expect(result.text).not.toContain('setup')
  })

  it('drops stale evaluation values and stack traces', () => {
    const result = buildWorkbenchReferenceContext({
      experiment: {
        files: { 'experiment.tsx': 'export default experiment({})' },
        dirty: true,
        revision: 4,
        successfulRevision: 3,
        status: 'Error',
        evaluation: {
          revision: 4,
          error: { title: 'Compile Error', message: 'current-error\n    at stack-secret' },
          vars: { previousSuccess: 123 },
        },
      },
    })

    expect(result.text).toContain('current-error')
    expect(result.text).not.toContain('stack-secret')
    expect(result.text).not.toContain('previousSuccess')
  })

  it('enforces UTF-8 truncation and the hard maximum', () => {
    const result = buildWorkbenchReferenceContext(
      {
        focus: { activeTab: 'experiment' },
        experiment: {
          files: { 'experiment.tsx': `시작-${'한글🙂'.repeat(20_000)}-끝` },
          dirty: true,
          revision: 1,
          successfulRevision: -1,
          status: 'Dirty',
        },
      },
      WORKBENCH_REFERENCE_MAX_BYTES * 2,
    )

    expect(result.byteLength).toBeLessThanOrEqual(WORKBENCH_REFERENCE_MAX_BYTES)
    expect(result.omittedByteLength).toBeGreaterThan(0)
    expect(result.text).not.toContain('\uFFFD')
  })

  it('prioritizes focus, diagnostics, the active source, other sources, and evaluation state in that order', () => {
    const result = buildWorkbenchReferenceContext({
      focus: { activeTab: 'ai-helper', activeExperimentFile: 'geometry.tsx' },
      experiment: {
        files: {
          'experiment.tsx': 'export default experiment({})',
          'geometry.tsx': 'export const Shape = () => <box size={[1, 2, 3]} />',
        },
        dirty: true,
        revision: 2,
        successfulRevision: 1,
        status: 'Error',
        evaluation: {
          revision: 2,
          diagnostics: [{ file: 'geometry.tsx', severity: 'error', message: 'Unknown prop' }],
        },
      },
      run: { operation: 'measurement', status: 'failed', error: 'run failed' },
    })

    const positions = [
      '## Current focus',
      '## Current diagnostics',
      '## Experiment source: geometry.tsx',
      '## Experiment source: experiment.tsx',
      '## Experiment current state',
      '## CAE run state',
    ].map((heading) => result.text.indexOf(heading))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })
})
