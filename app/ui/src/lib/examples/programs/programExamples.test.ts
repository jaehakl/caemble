import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { serializeEvaluatedDocumentSnapshot } from '../../cad/execution/snapshot'
import { evaluateDocumentEntry, loadCompiledCode } from '../../cad/execution/userModule'
import { ExperimentDefinition } from '../../cad/model/v3'
import { analyzeCadSource } from '../../cad/source/sourceAnalysis'
import { assertSimulationProgramManifest } from '../../simulation'
import type { CaembleProgramExample } from './types'
import { CAEMBLE_PROGRAM_EXAMPLE_SEED, caembleProgramExamples } from '.'

async function compileSource(source: string) {
  return (
    await transform(source, {
      format: 'cjs',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      loader: 'tsx',
      platform: 'browser',
      target: 'es2020',
    })
  ).code
}

async function prepareExample(example: CaembleProgramExample, seed = CAEMBLE_PROGRAM_EXAMPLE_SEED) {
  analyzeCadSource(example.structureCode, 'structure')
  analyzeCadSource(example.experimentCode, 'experiment')
  const entry = loadCompiledCode(await compileSource(example.experimentCode), 'experiment')
  expect(entry).toBeInstanceOf(ExperimentDefinition)
  const snapshot = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(entry, 'experiment', '2'.repeat(64), seed, {}, example.simulationCode, '3'.repeat(64)),
  )
  if (snapshot.kind !== 'experiment') throw new Error(`${example.id} did not produce an Experiment snapshot.`)
  return snapshot.simulationProgram
}

describe('Python CAE Experiment examples', () => {
  it('keeps unique immutable fixtures with complete manifest v2 task contracts', async () => {
    expect(new Set(caembleProgramExamples.map((example) => example.id)).size).toBe(caembleProgramExamples.length)

    for (const [index, example] of caembleProgramExamples.entries()) {
      const manifest = await prepareExample(example, 101 + index)
      expect(manifest).toMatchObject({
        formatVersion: 2,
        simulationApiVersion: 1,
        pythonSource: example.simulationCode,
        pythonSourceHash: '3'.repeat(64),
      })
      expect(Object.keys(manifest.tasks)).toEqual(example.verification.kernelTasks)
      expect(Object.keys(manifest.recordedData)).toEqual(example.verification.recordedData)
      Object.values(manifest.tasks).forEach((task) => {
        expect(task.descriptor).not.toBeNull()
        expect(task.kernel.descriptorHash).toMatch(/^[0-9a-f]{8}$/)
        expect(task.configHash).toMatch(/^[0-9a-f]{8}$/)
        expect(task.config).toEqual(expect.any(Object))
        expect(task.outputArtifacts).toEqual(expect.any(Object))
      })
      expect(manifest.recordedDataSchemaHash).toMatch(/^[0-9a-f]{8}$/)
      expect(() => assertSimulationProgramManifest(manifest)).not.toThrow()
      expect(Object.isFrozen(example)).toBe(true)
      expect(Object.isFrozen(example.verification)).toBe(true)
    }
  })

  it('rejects tampered task config, descriptor, output, and RecordedData contracts', async () => {
    const manifest = await prepareExample(caembleProgramExamples[0])
    const [taskName] = Object.keys(manifest.tasks)
    const task = manifest.tasks[taskName]
    const config = task.config as { parameters: Readonly<Record<string, unknown>> }

    expect(() =>
      assertSimulationProgramManifest({
        ...manifest,
        tasks: {
          ...manifest.tasks,
          [taskName]: {
            ...task,
            config: {
              ...(task.config as object),
              parameters: { ...config.parameters, maxIterations: 999 },
            },
          },
        },
      }),
    ).toThrow('config is not canonical')
    expect(() =>
      assertSimulationProgramManifest({
        ...manifest,
        tasks: {
          ...manifest.tasks,
          [taskName]: {
            ...task,
            descriptor: { ...task.descriptor!, description: 'tampered' },
          },
        },
      }),
    ).toThrow('descriptor does not match')
    expect(() =>
      assertSimulationProgramManifest({
        ...manifest,
        tasks: {
          ...manifest.tasks,
          [taskName]: { ...task, outputArtifacts: {} },
        },
      }),
    ).toThrow('resolved output specs')
    expect(() =>
      assertSimulationProgramManifest({
        ...manifest,
        recordedData: {
          ...manifest.recordedData,
          unexpected: { dtype: 'bool' },
        },
      }),
    ).toThrow('schema hash')
  })

  it('uses only the Python ABI for orchestration and awaitable records', () => {
    caembleProgramExamples.forEach((example) => {
      expect(example.experimentCode).not.toContain('simulate:')
      expect(example.experimentCode).not.toContain('sim.run(')
      expect(example.simulationCode).toMatch(/^async def simulate\(\*, sim, tasks, vars, world\):/u)
      example.verification.kernelTasks.forEach((task) => {
        expect(example.simulationCode).toContain(`tasks["${task}"]`)
      })
      example.verification.recordedData.forEach((name) => {
        expect(example.simulationCode).toMatch(new RegExp(`await\\s+sim\\.record\\(\\s*["']${name}["']`, 'u'))
      })
    })
  })
})
