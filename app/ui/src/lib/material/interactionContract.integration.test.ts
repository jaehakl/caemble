// @vitest-environment node
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compileCatalogExample, readCatalogExamples } from '../../../scripts/catalog-example-support'
import { executeCompiledDocument } from '../cad/execution/userModule'
import { Material } from '../cad/model/material'
import { MaterialInteraction } from '../cad/model/materialInteraction'
import { installCatalogRuntimeSlice } from '../catalog/runtime'
import { resolveSceneMaterials } from './document'
import { selectTaskInteractionModels } from './interactions'
import { materialVarsHash } from './resolution'

const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
const example = examples.find((item) => item.key === 'sliding-contact')!
const compiled = compileCatalogExample(example, catalog)
beforeEach(() => installCatalogRuntimeSlice(catalog))

function evaluate(friction = 0.4, extra = '') {
  const source = extra
    ? compileCatalogExample(
        {
          ...example,
          sourceBundle: {
            ...example.sourceBundle,
            files: {
              ...example.sourceBundle.files,
              'material.tsx': example.sourceBundle.files['material.tsx'] + extra,
            },
          },
        },
        catalog,
      )
    : compiled
  return executeCompiledDocument(source, { friction }, example.sourceBundle.files['simulate.py'])
}

describe('automatically discovered MaterialInteractions', () => {
  it('evaluates exported callbacks from Candidate Vars and deduplicates aliases', () => {
    const calls = vi.spyOn(MaterialInteraction.prototype, 'evaluate')
    const first = evaluate(0.2, '\nexport const Alias = FloorBlock\n')
    expect(calls).toHaveBeenCalledOnce()
    calls.mockRestore()
    expect(Object.keys(first.interactions!)).toEqual(['FloorBlock'])
    expect(first.interactions!.FloorBlock.models.friction.parameters.muDynamic).toMatchObject({ value: 0.2 })
    expect(evaluate(0.7).interactions!.FloorBlock.models.friction.parameters.muDynamic).toMatchObject({ value: 0.7 })
    expect(example.sourceBundle.files['experiment.tsx']).not.toContain('FloorBlock')
  })

  it('rejects reversed duplicates even when both endpoints are unused', () => {
    expect(() =>
      evaluate(
        0.4,
        `
export const A = new Material('UnusedA', { models: {} })
export const B = new Material('UnusedB', { models: {} })
export const AB = new MaterialInteraction('AB', { between: [A, B] })
export const BA = new MaterialInteraction('BA', { between: [B, A] })
`,
      ),
    ).toThrow(/material pairs must be unique/)
  })

  it('validates unused declarations but stores only used pairs', () => {
    expect(
      Object.keys(
        evaluate(
          0.4,
          `
export const A = new Material('UnusedA', { models: {} })
export const Unused = new MaterialInteraction('Unused', { between: [A, Floor] })
`,
        ).interactions!,
      ),
    ).toEqual(['FloorBlock'])
    expect(() =>
      evaluate(
        0.4,
        `
export const Conflict = new MaterialInteraction('Conflict', { between: [new Material('Floor', { models: {} }), Floor] })
`,
      ),
    ).toThrow(/conflicting definitions/)
  })

  it('supports same-material pairs, distinct models, and rejects duplicate model identities or wrong subjects', () => {
    const material = new Material('A', { models: {} })
    const models = evaluate().interactions!.FloorBlock.models
    expect(new MaterialInteraction('AA', { between: [material, material], models }).evaluate({}).between).toEqual([
      'A',
      'A',
    ])
    expect(() =>
      new MaterialInteraction('AA', {
        between: [material, material],
        models: {
          first: models.friction,
          second: models.friction,
        },
      }).evaluate({}),
    ).toThrow(/duplicate|once/i)
    expect(() => new Material('A', { models })).toThrow(/material/)
  })

  it('freezes automatic Task bindings and rejects changed selections on replay', () => {
    const evaluated = evaluate()
    const resolved = resolveSceneMaterials(evaluated, null, catalog)
    expect(resolved.interactionSelections!.motion.contact).toContainEqual({
      between: ['Block', 'Floor'],
      interaction: 'FloorBlock',
      models: { friction: 'friction', restitution: 'rebound' },
    })
    expect(resolved.interactionSelections!.motion.contact).toContainEqual({
      between: ['Block', 'Block'],
      interaction: null,
      models: { friction: null, restitution: null },
    })
    const saved = {
      experiment: resolved.materialSnapshot,
      tasks: resolved.taskMaterialSnapshots,
      selections: resolved.materialSelections,
      interactions: resolved.interactions,
      interactionSelections: resolved.interactionSelections,
      modelDefinitions: resolved.modelDefinitions,
      sourceHash: evaluated.sourceHash,
      varsHash: materialVarsHash(evaluated.variables),
    }
    expect(resolveSceneMaterials(evaluated, saved, catalog).interactions).toEqual(resolved.interactions)
    expect(() =>
      resolveSceneMaterials(evaluated, { ...saved, interactionSelections: { motion: {} } }, catalog),
    ).toThrow(/Saved Interaction/)
  })

  it('requires explicit selection only for competing models within a group', () => {
    const evaluated = evaluate()
    const descriptor = catalog.solvers.find((item) => item.name === 'rigid_body')!.descriptor
    const role = descriptor.interactions![0]
    const competing = {
      ...descriptor,
      interactions: [
        {
          ...role,
          modelGroups: [
            {
              ...role.modelGroups[0],
              oneOf: ['contact.coulomb@1', 'contact.restitution@1'],
            },
          ],
        },
      ],
    }
    const config = evaluated.simulationProgram.tasks.motion.config as Readonly<Record<string, unknown>>
    const scenes = { experiment: evaluated.scene, task: evaluated.taskScenes.motion }
    expect(() =>
      selectTaskInteractionModels(competing, config, scenes, evaluated.interactions!, catalog, 'motion'),
    ).toThrow(/multiple models/)
    const selected = selectTaskInteractionModels(
      competing,
      { ...config, interactionModels: { contact: { FloorBlock: { friction: 'friction' } } } },
      scenes,
      evaluated.interactions!,
      catalog,
      'motion',
    )
    expect(selected.contact.find((pair) => pair.interaction === 'FloorBlock')!.models.friction).toBe('friction')
  })
})
