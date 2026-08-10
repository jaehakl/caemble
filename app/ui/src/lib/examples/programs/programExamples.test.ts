import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '../../cad/compiler/types'
import { executeCompiledDocument } from '../../cad/execution/userModule'
import { analyzeCadSource, analyzeTaskSource } from '../../cad/source/sourceAnalysis'
import { assertSimulationProgramManifest } from '../../cad/simulation'
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
  const sourceHash = '2'.repeat(64)
  const sources = await Promise.all(
    Object.entries(example.experimentSourceBundle.files)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(async ([entryFile, source]) => {
        if (entryFile === 'experiment.tsx') analyzeCadSource(source, 'experiment')
        else analyzeTaskSource(source)
        const compiled: CompiledCadSource = {
          apiVersion: 4,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compileSource(source),
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  const document: CompiledCadDocument = {
    apiVersion: 4,
    compilerVersion: CAD_COMPILER_VERSION,
    sourceHash,
    sources: Object.fromEntries(sources),
  }
  const result = executeCompiledDocument(
    document,
    'experiment',
    seed,
    {},
    example.experimentSourceBundle.files['simulate.py'],
  )
  if (result.kind !== 'experiment') throw new Error(`${example.id} did not produce an Experiment snapshot.`)
  return result.simulationProgram
}

describe('Python CAE Experiment examples', () => {
  it('keeps unique immutable fixtures with compact manifest v4 tasks', async () => {
    expect(new Set(caembleProgramExamples.map((example) => example.id)).size).toBe(caembleProgramExamples.length)

    for (const [index, example] of caembleProgramExamples.entries()) {
      const manifest = await prepareExample(example, 101 + index)
      expect(manifest).toMatchObject({
        formatVersion: 4,
        simulationApiVersion: 2,
        pythonSource: example.experimentSourceBundle.files['simulate.py'],
      })
      expect(Object.keys(manifest.tasks)).toEqual(example.verification.kernelTasks)
      expect(Object.keys(manifest.recordedData)).toEqual(example.verification.recordedData)
      expect(() => assertSimulationProgramManifest(manifest)).not.toThrow()
      expect(
        Object.keys(example.experimentSourceBundle.files).filter((path) => path.startsWith('tasks/')),
      ).toHaveLength(example.verification.kernelTasks.length)
    }
  })

  it('uses only the Python v2 ABI for orchestration and records', () => {
    caembleProgramExamples.forEach((example) => {
      const pythonSource = example.experimentSourceBundle.files['simulate.py']
      expect(example.experimentSourceBundle.files['experiment.tsx']).not.toContain('sim.run(')
      expect(pythonSource).toMatch(/^async def simulate\(\*, sim, tasks, vars\):/u)
      expect(pythonSource).not.toContain('world')
      example.verification.kernelTasks.forEach((task) => expect(pythonSource).toContain(`tasks["${task}"]`))
      example.verification.recordedData.forEach((name) =>
        expect(pythonSource).toMatch(new RegExp(`await\\s+sim\\.record\\(\\s*["']${name}["']`, 'u')),
      )
    })
  })
})
