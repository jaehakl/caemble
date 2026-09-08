// @vitest-environment node
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compileCatalogExample, readCatalogExamples } from '../../../scripts/catalog-example-support'
import type { ModelParameterSchema } from '@/contracts/catalog'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import type { KernelDescriptor } from '@/contracts/solver'
import type { CadScene, CadSceneMaterial } from '@/lib/cad/evaluation/types'
import { Material } from '@/lib/cad/model/material'
import { normalizeMaterialModels, normalizeModelParameters } from '@/lib/cad/model/materialNormalization'
import { executeCompiledDocument, inspectCompiledDocument } from '@/lib/cad/execution/userModule'
import type { EvaluatedRuntimeDocumentSnapshot } from '@/lib/cad/execution/snapshot'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { materialVarsHash, resolveMaterialSnapshot } from './resolution'
import { selectTaskMaterialModels } from './selection'
import { resolveSceneMaterials } from './document'

const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
beforeEach(() => installCatalogRuntimeSlice(catalog))

function optical(name: string, n: number) {
  return new Material(name, {
    models: {
      optical: {
        model: 'optics.constant-complex-index@1',
        parameters: { n: { value: n, unit: '{fraction}' }, k: { value: 0, unit: '1' } },
      },
    },
  })
}

function scene(materials: CadSceneMaterial[]): CadScene {
  return {
    lengthUnit: 'm',
    geometryGroups: [],
    surfaceGroups: [],
    tree: { key: 'root', label: 'root', children: [] },
    parts: materials.map((material, index) => ({
      id: String(index),
      materialRole: 'body',
      material,
      geometry: null,
      surfaces: [],
    })),
  }
}

describe('Experiment-owned Material Model inputs', () => {
  it('permits independent Experiments to assign different coefficients to the same local name', () => {
    const first = resolveMaterialSnapshot([optical('Glass', 1.5)])
    const second = resolveMaterialSnapshot([optical('Glass', 1.8)])
    expect(first.materialSnapshot.materials.Glass.models.optical.parameters.n).toMatchObject({ value: 1.5 })
    expect(second.materialSnapshot.materials.Glass.models.optical.parameters.n).toMatchObject({ value: 1.8 })
  })

  it('allows identical shared definitions and rejects conflicting same-name Materials in one run', () => {
    expect(
      Object.keys(resolveMaterialSnapshot([optical('Glass', 1.5), optical('Glass', 1.5)]).materialSnapshot.materials),
    ).toEqual(['Glass'])
    expect(() => resolveMaterialSnapshot([optical('Glass', 1.5), optical('Glass', 1.8)])).toThrow(
      /Glass.*conflicting definitions/u,
    )
  })

  it('rejects external selectors, hidden sampling, unknown models and missing parameters', () => {
    expect(() => new Material('Glass', { source: 'reference' } as never)).toThrow(/not allowed/u)
    expect(() => new Material('Glass', { errorRate: 0.1 } as never)).toThrow(/not allowed/u)
    expect(() => new Material('Glass', { models: { optical: { model: 'typo@1', parameters: {} } } })).toThrow(
      /not registered/u,
    )
    expect(
      () =>
        new Material('Glass', {
          models: {
            optical: {
              model: 'optics.constant-complex-index@1',
              parameters: { n: { value: 1.5, unit: '{fraction}' } },
            },
          },
        }),
    ).toThrow(/Material Glass.models.optical.parameters.k is required/u)
  })

  it('requires complete optional objects and every repeated parameter set', () => {
    const pair: ModelParameterSchema = {
      kind: 'object',
      required: ['a', 'b'],
      fields: { a: { kind: 'value', shape: [] }, b: { kind: 'value', shape: [] } },
    }
    const schema: ModelParameterSchema = { kind: 'object', fields: { pair, terms: { kind: 'list', items: pair } } }
    expect(normalizeModelParameters(schema, {}, 'parameters')).toEqual({})
    expect(
      normalizeModelParameters(
        schema,
        {
          terms: [
            { a: 1, b: 2 },
            { a: 3, b: 4 },
          ],
        },
        'parameters',
      ),
    ).toEqual({
      terms: [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
    })
    expect(() => normalizeModelParameters(schema, { pair: { a: 1 } }, 'parameters')).toThrow(
      'parameters.pair.b is required',
    )
    expect(() => normalizeModelParameters(schema, { terms: [{ a: 1, b: 2 }, { a: 3 }] }, 'parameters')).toThrow(
      'parameters.terms[1].b is required',
    )
  })

  it('normalizes units while preserving explicit float dtype and rejects reordered sample frequencies', () => {
    const schema = catalog.materialModels.find(
      (model) => model.key === 'optics.frequency-sampled-absorption@1',
    )!.parameterSchema
    const samples = [
      { frequency: { value: 100, unit: 'GHz' }, alpha: { dtype: 'float32', value: 2, unit: 'cm-1' } },
      { frequency: { value: 200, unit: 'GHz' }, alpha: { value: 3, unit: 'cm-1' } },
    ]
    expect(normalizeModelParameters(schema, { samples }, 'parameters')).toMatchObject({
      samples: [
        { frequency: { value: 1e11, unit: 'Hz' }, alpha: { dtype: 'float32', value: 200, unit: 'm-1' } },
        { frequency: { value: 2e11, unit: 'Hz' } },
      ],
    })
    expect(() => normalizeModelParameters(schema, { samples: [...samples].reverse() }, 'parameters')).toThrow(
      /strictly increasing/u,
    )
  })

  it('defaults omitted quantity dtype to float64 independently of the schema float dtype', () => {
    const schema: ModelParameterSchema = { kind: 'value', dtype: 'float32', quantityKind: 'Frequency', unit: 'Hz' }
    expect(normalizeModelParameters(schema, { value: 1e100, unit: 'Hz' }, 'frequency')).toEqual({
      dtype: 'float64',
      value: 1e100,
      unit: 'Hz',
    })
    expect(() => normalizeModelParameters(schema, { value: 1e100, unit: 'Hz', dtype: 'float32' }, 'frequency')).toThrow(
      /float32 range/u,
    )
    expect(() => normalizeModelParameters({ kind: 'value', dtype: 'float32' }, 1e100, 'coefficient')).toThrow(
      /float32 range/u,
    )
  })

  it('makes variable fingerprints stable by field order and sensitive to every tensor coefficient', () => {
    expect(materialVarsHash({ n: 1.5, tensor: [1, 2] })).toBe(materialVarsHash({ tensor: [1, 2], n: 1.5 }))
    expect(materialVarsHash({ n: 1.5, tensor: [1, 2] })).not.toBe(materialVarsHash({ n: 1.5, tensor: [1, 3] }))
  })

  it('uses an explicitly supplied Catalog throughout model and quantity normalization', () => {
    const glass = optical('Glass', 1.5)
    installCatalogRuntimeSlice({ ...catalog, materialModels: [], quantityKinds: [], solvers: [] })
    expect(() => normalizeMaterialModels(glass.models, 'models')).toThrow(/not registered/u)
    expect(normalizeMaterialModels(glass.models, 'models', catalog)).toEqual(glass.models)
  })
})

describe('saved Material snapshot replay', () => {
  let evaluated: EvaluatedRuntimeDocumentSnapshot
  let saved: MeasurementMaterialSnapshot
  beforeAll(() => {
    installCatalogRuntimeSlice(catalog)
    const example = examples.find((item) => item.key === 'electro-thermal-notched-bar')!
    const compiled = compileCatalogExample(example, catalog)
    const { varsSchema } = inspectCompiledDocument(compiled)
    const variables = Object.fromEntries(
      Object.entries(varsSchema).map(([key, entry]) => [key, (entry.min + entry.max) / 2]),
    )
    evaluated = executeCompiledDocument(compiled, variables, example.sourceBundle.files['simulate.py'])
    const resolved = resolveSceneMaterials(evaluated, null, catalog)
    saved = {
      experiment: resolved.materialSnapshot,
      tasks: resolved.taskMaterialSnapshots,
      sourceHash: evaluated.sourceHash,
      varsHash: materialVarsHash(variables),
      modelDefinitions: resolved.modelDefinitions,
      selections: resolved.materialSelections,
    }
  })

  it('accepts JSONB-style object-key reordering without changing the recorded inputs', () => {
    const reordered = JSON.parse(JSON.stringify(saved), (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    )
    const replay = resolveSceneMaterials(evaluated, reordered, catalog)
    expect(replay.materialSnapshot).toEqual(saved.experiment)
    expect(replay.materialSelections).toEqual(saved.selections)
  })

  it('rejects a saved snapshot missing an Experiment Material', () => {
    expect(() => resolveSceneMaterials(evaluated, { ...saved, experiment: { materials: {} } }, catalog)).toThrow(
      /experiment.materials must contain exactly.*Copper/u,
    )
  })
})

describe('per-Material Solver model selection', () => {
  const ray = catalog.solvers.find((solver) => solver.name === 'ray-tracing')!.descriptor
  const descriptor: KernelDescriptor = {
    ...ray,
    materials: ray.materials.map((role) => ({ ...role, target: { category: 'geometry', source: 'experiment' } })),
  }

  it('rejects an applicable geometry part without a Material for a required role', () => {
    const experiment = scene([optical('Glass', 1.5)])
    experiment.parts = experiment.parts.map(({ material: _material, ...part }) => part)
    expect(() => selectTaskMaterialModels(descriptor, {}, { experiment, task: scene([]) }, 'config')).toThrow(
      /Material/iu,
    )
  })

  it('rejects ambiguous instances and accepts an explicit compatible Task selection', () => {
    const glass = optical('Glass', 1.5)
    const material = { ...glass, models: { ...glass.models, alternative: glass.models.optical } }
    const scenes = { experiment: scene([material]), task: scene([]) }
    expect(() => selectTaskMaterialModels(descriptor, {}, scenes, 'tasks.trace.config')).toThrow(
      /Glass.opticalResponse is ambiguous/u,
    )
    const selected = selectTaskMaterialModels(
      descriptor,
      { materialModels: { opticalDomain: { Glass: { opticalResponse: 'alternative' } } } },
      scenes,
      'tasks.trace.config',
    )
    expect(selected.opticalDomain.Glass.opticalResponse).toBe('alternative')
  })

  it('checks every Material separately and ignores valid models consumed by other solvers', () => {
    const valid = optical('Glass', 1.5)
    const thermal = {
      model: 'heat.fourier-conduction@1',
      parameters: {
        k: {
          value: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          unit: 'W.m-1.K-1',
        },
      },
    }
    const augmented = { ...valid, models: { ...valid.models, thermal } }
    expect(
      selectTaskMaterialModels(descriptor, {}, { experiment: scene([augmented]), task: scene([]) }, 'config')
        .opticalDomain.Glass,
    ).toEqual({ opticalResponse: 'optical' })
    expect(() =>
      selectTaskMaterialModels(
        descriptor,
        {},
        { experiment: scene([valid, { name: 'Other', models: { thermal } }]), task: scene([]) },
        'config',
      ),
    ).toThrow(/Other.opticalResponse requires/u)
    expect(() =>
      selectTaskMaterialModels(
        descriptor,
        { materialModels: { opticalDomain: { Missing: { opticalResponse: 'optical' } } } },
        { experiment: scene([valid]), task: scene([]) },
        'config',
      ),
    ).toThrow(/does not address an applicable/u)
  })
})
