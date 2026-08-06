import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { defaultCode } from '../../defaultCode'
import { defaultExperimentCode } from '../../defaultExperimentCode'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './snapshot'
import { executeCompiledCode, executeCompiledSource, requireCaembleModule } from './userModule'

async function compile(source: string) {
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

describe('compiled CAD source execution', () => {
  it('exposes only the unversioned public authoring modules', () => {
    expect(requireCaembleModule('@caemble/core')).toMatchObject({
      experiment: expect.any(Function),
      Mat: expect.any(Function),
      Material: expect.any(Function),
      structure: expect.any(Function),
    })
    expect(requireCaembleModule('@caemble/kernels')).toEqual({
      dcCurrentDensity: expect.any(Function),
      steadyStateHeat: expect.any(Function),
    })
    expect(requireCaembleModule('@caemble/kernels')).not.toHaveProperty('execute')

    expect(() => requireCaembleModule('@caemble/core/versioned')).toThrow('Unsupported Caemble runtime import')
    expect(() => requireCaembleModule('@caemble/kernels/versioned')).toThrow('Unsupported Caemble runtime import')
    expect(() => requireCaembleModule('./local-module')).toThrow('Unsupported Caemble runtime import')
  })

  it('evaluates the default Structure with externally supplied vars without recompiling', async () => {
    const code = await compile(defaultCode)

    for (const [seed, notchSize, notchPosition] of [
      [101, [20, 4, 5], [-10, 4, 2.5]],
      [202, [40, 6, 7], [10, 5, 3.5]],
    ] as const) {
      const result = executeCompiledCode(code, 'structure', '1'.repeat(64), seed, {
        conductorSize: [100, 12, 10],
        electricalConductivity: 5.96e7,
        notchPosition,
        notchSize,
      })
      const part = result.scene.parts[0]

      expect(result).toMatchObject({
        kind: 'structure',
        seed,
        sourceHash: '1'.repeat(64),
        variables: { notchPosition, notchSize },
      })
      expect(result).not.toHaveProperty('simulationProgram')
      expect(result.scene.geometryGroups[0]).toMatchObject({
        name: 'conductor',
        geometryIds: ['conductor'],
      })
      expect(result.scene.surfaceGroups.map((group) => group.name)).toEqual(['sourceTerminal', 'referenceTerminal'])
      expect(part.material).toMatchObject({
        name: 'Copper',
        source: 'reference',
        variables: {
          'electrical.conductivity': {
            dtype: 'float64',
            unit: 'S.m-1',
            quantityKind: 'electromagnetism.ElectricConductivity',
            basis: identityCartesianBasis,
          },
        },
      })
      expect(geometries.geom3.isA(part.geometry)).toBe(true)
      expect(measurements.measureVolume(part.geometry)).toBeGreaterThan(0)
    }
  })

  it('evaluates one Experiment source into the global program manifest', async () => {
    const sourceHash = '2'.repeat(64)
    const simulationCode = 'async def simulate(*, sim, tasks, vars, world):\n    return None\n'
    const result = executeCompiledCode(
      await compile(defaultExperimentCode),
      'experiment',
      sourceHash,
      17,
      {},
      simulationCode,
      '3'.repeat(64),
    )
    const snapshot = serializeEvaluatedDocumentSnapshot(result)

    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    if (snapshot.kind !== 'experiment') {
      throw new Error('Expected an Experiment snapshot.')
    }
    expect(snapshot.simulationProgram).toMatchObject({
      formatVersion: 2,
      programHash: sourceHash,
      simulationApiVersion: 1,
      pythonSourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      tasks: {
        electric: {
          kernel: {
            name: 'dc-current-density',
            version: '0.0.0',
            descriptorHash: expect.any(String),
          },
          config: expect.any(Object),
          configHash: expect.any(String),
          outputArtifacts: expect.any(Object),
        },
      },
      recordedData: {
        measuredCurrent: {
          dtype: 'float64',
          unit: 'A',
          quantityKind: 'electromagnetism.ElectricCurrent',
        },
      },
    })
    expect(snapshot.simulationProgram).not.toHaveProperty('outputs')
    expect(result.scene.parts.map((part) => part.id)).toEqual(['experiment-device'])
  })

  it('does not create a runnable manifest when Python simulation source is absent', async () => {
    const code = await compile(defaultExperimentCode)

    expect(() => executeCompiledCode(code, 'experiment', '2'.repeat(64), 17)).toThrow(
      'Experiment evaluation requires non-empty Python simulation source',
    )
  })

  it('checks the compiled source identity before loading it', async () => {
    const compiledSource: CompiledCadSource = {
      apiVersion: 3,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'structure.tsx',
      code: await compile(defaultCode),
      sourceHash: '3'.repeat(64),
    }

    expect(executeCompiledSource(compiledSource, 'structure', 5)).toMatchObject({
      kind: 'structure',
      seed: 5,
      sourceHash: compiledSource.sourceHash,
    })
    expect(() => executeCompiledSource(compiledSource, 'experiment', 5)).toThrow('does not match experiment')
  })

  it('rejects the wrong default-export kind with a direct authoring error', async () => {
    const structureCode = await compile(defaultCode)
    const experimentCode = await compile(defaultExperimentCode)

    expect(() => executeCompiledCode(structureCode, 'experiment')).toThrow(
      'Experiment Source must export default experiment',
    )
    expect(() => executeCompiledCode(experimentCode, 'structure')).toThrow(
      'Structure Source must export default structure',
    )
  })
})
