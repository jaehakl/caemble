import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_REFERENCE_MAX_BYTES,
  buildWorkbenchReferenceContext,
  type WorkbenchContextInput,
} from './workbenchContext'

const evaluation = {
  revision: 7,
  diagnostics: [
    {
      file: 'structure.tsx',
      severity: 'error',
      phase: 'semantic',
      code: 2322,
      message: 'Type mismatch\n    at compiled-secret:1:2',
    },
  ],
  error: { title: 'Type Error', message: 'The size is invalid.\nTraceback (most recent call last):\nstack-secret' },
  vars: { width: 2 },
  varsSchema: { width: { min: 1, max: 4 } },
  materialWarnings: ['Conductivity is missing.'],
} as const

describe('buildWorkbenchReferenceContext', () => {
  it('includes only the explicit current Workbench source and safe state fields', () => {
    const input = {
      focus: { activeTab: 'structure', activeExperimentFile: 'tasks/thermal.tsx' },
      structure: {
        source: "export default structure({ lengthUnit: 'mm' })",
        dirty: true,
        revision: 7,
        successfulRevision: -1,
        status: 'Error',
        evaluation,
      },
      experiment: {
        files: {
          'experiment.tsx': 'export default experiment({})',
          'tasks/thermal.tsx': 'export default task({})',
          'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None',
        },
        dirty: false,
        revision: 3,
        successfulRevision: 3,
        status: 'Ready',
        evaluation: { ...evaluation, revision: 3, diagnostics: [], error: null },
      },
      selection: {
        sample: { selected: true, applied: true },
        setup: { selected: true, applied: false },
        measurement: { selected: false, applied: false },
      },
      run: { operation: 'measurement', status: 'failed', stage: null, error: 'Solver failed\n    at stack-secret' },
      recordedData: { raw: 'recorded-secret' },
      scene: 'scene-secret',
      mesh: 'mesh-secret',
      compiledSource: 'compiled-output-secret',
      sourceMap: 'source-map-secret',
      dbRow: { token: 'db-secret' },
    } as unknown as WorkbenchContextInput

    const result = buildWorkbenchReferenceContext(input)

    expect(result.text).toContain('export default structure')
    expect(result.text).toContain('tasks/thermal.tsx')
    expect(result.text).toContain('Type mismatch')
    expect(result.text).toContain('Solver failed')
    expect(result.text).toContain('"selected": true')
    expect(result.text).not.toContain('stack-secret')
    expect(result.text).not.toContain('recorded-secret')
    expect(result.text).not.toContain('scene-secret')
    expect(result.text).not.toContain('mesh-secret')
    expect(result.text).not.toContain('compiled-output-secret')
    expect(result.text).not.toContain('source-map-secret')
    expect(result.text).not.toContain('db-secret')
    expect(result.chunks[1]?.id).toBe('structure-source')
  })

  it('drops stale evaluation details and previous successful values', () => {
    const result = buildWorkbenchReferenceContext({
      structure: {
        source: 'export default structure({})',
        dirty: true,
        revision: 8,
        successfulRevision: 7,
        status: 'Dirty',
        evaluation: {
          ...evaluation,
          vars: { staleVariable: 999 },
          materialWarnings: ['stale-warning'],
        },
      },
      experiment: {
        files: { 'experiment.tsx': 'export default experiment({})' },
        dirty: true,
        revision: 4,
        successfulRevision: 3,
        status: 'Error',
        evaluation: {
          revision: 4,
          error: { title: 'Compile Error', message: 'current-error' },
          vars: { previousSuccess: 123 },
          materialWarnings: ['previous-warning'],
        },
      },
    })

    expect(result.text).not.toContain('Type mismatch')
    expect(result.text).not.toContain('staleVariable')
    expect(result.text).not.toContain('stale-warning')
    expect(result.text).toContain('current-error')
    expect(result.text).not.toContain('previousSuccess')
    expect(result.text).not.toContain('previous-warning')
  })

  it('does not expose the previous successful evaluation while the same revision is rerunning', () => {
    const result = buildWorkbenchReferenceContext({
      structure: {
        source: 'export default structure({})',
        dirty: false,
        revision: 7,
        successfulRevision: 7,
        status: 'Evaluating',
        evaluation: {
          ...evaluation,
          diagnostics: [{ ...evaluation.diagnostics[0], message: 'previous-diagnostic' }],
          vars: { previousVariable: 999 },
          materialWarnings: ['previous-warning'],
        },
      },
    })

    expect(result.text).not.toContain('previous-diagnostic')
    expect(result.text).not.toContain('previousVariable')
    expect(result.text).not.toContain('previous-warning')
    expect(result.text).toContain('"evaluationDetailsCurrent": false')
  })

  it('summarizes array and encoded tensors without copying their raw payloads', () => {
    const values = Array.from({ length: 100 }, (_, index) => index)
    const result = buildWorkbenchReferenceContext({
      structure: {
        source: 'export default structure({})',
        dirty: false,
        revision: 2,
        successfulRevision: 2,
        status: 'Ready',
        evaluation: {
          revision: 2,
          vars: {
            values,
            encoded: {
              shape: [10, 10],
              storage: { kind: 'base64', data: 'raw-base64-secret', byteLength: 800 },
            },
            attached: {
              shape: [1000],
              storage: { kind: 'attachments', ids: ['attachment-secret'], byteLength: 8000 },
            },
          },
        },
      },
    })

    expect(result.text).toContain('"shape": [')
    expect(result.text).toContain('"omittedElements": 88')
    expect(result.text).toContain('"kind": "base64"')
    expect(result.text).toContain('"byteLength": 800')
    expect(result.text).not.toContain('raw-base64-secret')
    expect(result.text).not.toContain('attachment-secret')
    expect(result.text).not.toContain('99,')
  })

  it('truncates UTF-8 sources with omission metadata and enforces the hard maximum', () => {
    const source = `시작-${'한글🙂'.repeat(20_000)}-끝`
    const result = buildWorkbenchReferenceContext(
      {
        focus: { activeTab: 'structure' },
        structure: {
          source,
          dirty: true,
          revision: 1,
          successfulRevision: -1,
          status: 'Dirty',
        },
      },
      4_096,
    )

    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(4_096)
    expect(result.byteLength).toBeLessThanOrEqual(4_096)
    expect(result.omittedByteLength).toBeGreaterThan(0)
    expect(result.text).toContain('UTF-8 bytes omitted')
    expect(result.text).not.toContain('\uFFFD')

    const hardCapped = buildWorkbenchReferenceContext(
      {
        structure: {
          source: 'x'.repeat(WORKBENCH_REFERENCE_MAX_BYTES * 2),
          dirty: true,
          revision: 1,
          successfulRevision: -1,
          status: 'Dirty',
        },
      },
      WORKBENCH_REFERENCE_MAX_BYTES * 2,
    )
    expect(hardCapped.byteLength).toBeLessThanOrEqual(WORKBENCH_REFERENCE_MAX_BYTES)
  })
})
