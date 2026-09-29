// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertExperimentSourcePath,
  assertExperimentSourcePaths,
  experimentTypeScriptPaths,
  resolveExperimentModuleSpecifier,
} from './moduleResolution'
import {
  addExperimentSourceFile,
  addExperimentTask,
  createCadSourceDocument,
  createExperimentSourceBundle,
  removeExperimentSourceFile,
  updateExperimentSourceFile,
} from './document'
import { assertExperimentModuleGraph } from './sourceAnalysis'
import { parseBuildArtifact } from '@/lib/cae/artifact'

const forbidden = [
  'object.ts',
  'sensor.ts',
  'unused.tsx',
  'lib/profile.ts',
  'tasks/nested/trace.tsx',
  'tasks/1trace.tsx',
  'tasks/trace.ts',
  'tasks/trace.tsx\n',
  '../experiment.tsx',
  '/experiment.tsx',
  'Experiment.tsx',
  'extra.py',
  'notes.json',
]

describe('Experiment source paths', () => {
  it('accepts exactly core files and flat named Tasks', () => {
    const paths = ['experiment.tsx', 'geometry.tsx', 'material.tsx', 'simulate.py', 'tasks/Trace_2-a.tsx']
    expect(() => assertExperimentSourcePaths(paths)).not.toThrow()
    expect(experimentTypeScriptPaths(Object.fromEntries(paths.map((path) => [path, ''])))).toHaveLength(4)
    expect(resolveExperimentModuleSpecifier({ 'experiment.tsx': '' }, 'tasks/Trace_2-a.tsx', '../experiment')).toBe(
      'experiment.tsx',
    )
  })
  it.each(forbidden)('rejects unused or misplaced source %s before filtering or parsing', (path) => {
    expect(() => assertExperimentSourcePath(path)).toThrow('Allowed: experiment.tsx')
    expect(() => experimentTypeScriptPaths({ [path]: '' })).toThrow(path.trim())
    expect(() => assertExperimentModuleGraph({ [path]: '' })).toThrow('Allowed:')
    expect(() =>
      parseBuildArtifact({
        kind: 'caemble.build',
        version: 2,
        source_hash: 'a'.repeat(64),
        catalog_revision: 'test',
        builder_version: '2',
        mode: 'candidate',
        source_bundle: { files: { [path]: '' } },
        items: [{ index: 1, file: 'items/1.json', input_hash: 'b'.repeat(64), byte_length: 1 }],
      }),
    ).toThrow('Allowed:')
  })
  it('keeps historical bundles readable and repairable, while rejecting new arbitrary files', () => {
    const document = createCadSourceDocument('experiment', createExperimentSourceBundle({ 'object.ts': 'old' }))
    expect(updateExperimentSourceFile(document, 'object.ts', 'repair').sourceBundle.files['object.ts']).toBe('repair')
    expect(removeExperimentSourceFile(document, 'object.ts').sourceBundle.files).not.toHaveProperty('object.ts')
    expect(() => addExperimentSourceFile(document, 'sensor.ts', '')).toThrow('sensor.ts')
    expect(() => updateExperimentSourceFile(document, 'sensor.ts', '')).toThrow('sensor.ts')
    expect(() => updateExperimentSourceFile(document, 'toString', '')).toThrow('toString')
    expect(addExperimentTask(document, 'trace', 'task').sourceBundle.files['tasks/trace.tsx']).toBe('task')
    expect(() => addExperimentTask(document, 'nested/trace', '')).toThrow('nested/trace')
  })
  it('rejects case collisions', () => {
    expect(() => assertExperimentSourcePaths(['tasks/Trace.tsx', 'tasks/trace.tsx'])).toThrow('case')
  })
})
