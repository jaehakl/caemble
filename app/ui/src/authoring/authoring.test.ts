// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyzeGeometrySource } from '../lib/cad/source/sourceAnalysis'
import { analyzeCalculationDependencies } from '../lib/calculation/dependencies'
import { compileNodeCalculation, runNodeCalculation } from '../platform/node/calculation'
import { getAuthoringGuide, getAuthoringReference, listAuthoringGuides, searchAuthoringReference } from './index'
import { calculationExamples, calculationInvalidExamples, geometrySyntaxExamples } from './examples'

describe('authoring instructions use executable language fixtures', () => {
  for (const example of calculationExamples) {
    it(`executes ${example.id} with the shared compiler and runtime`, async () => {
      expect(analyzeCalculationDependencies(example.source, Object.keys(example.input))).toEqual(['signal'])
      const result = await runNodeCalculation(example.source, structuredClone(example.input))
      expect(result.output).toEqual(example.expected)
      expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/)
      expect(getAuthoringReference(example.id)?.example).toEqual({
        source: example.source,
        input: example.input,
        expected: example.expected,
      })
    })
  }

  for (const example of calculationInvalidExamples) {
    it(`rejects ${example.id} at its documented ${example.stage} stage`, async () => {
      if (example.stage === 'dependencies') {
        expect(() => analyzeCalculationDependencies(example.source, ['signal'])).toThrow()
      } else if (example.stage === 'output') {
        await expect(compileNodeCalculation(example.source)).resolves.toHaveProperty('sourceHash')
        await expect(runNodeCalculation(example.source, {})).rejects.toThrow()
      } else {
        await expect(compileNodeCalculation(example.source)).rejects.toMatchObject({ code: example.stage })
      }
    })
  }

  it('validates complete geometry syntax fixtures with the actual AST analyzer', () => {
    expect(analyzeGeometrySource(geometrySyntaxExamples.valid).exports.map(({ name }) => name)).toEqual(['Part'])
    expect(() => analyzeGeometrySource(geometrySyntaxExamples.invalid)).toThrow()
  })

  it('keeps all progressive guide references resolvable and search results bounded', () => {
    expect(listAuthoringGuides().map(({ id }) => id)).toEqual(['experiment', 'calculation', 'solver'])
    for (const guide of listAuthoringGuides()) {
      expect(getAuthoringGuide(guide.id)).toBe(guide)
      for (const id of guide.referenceIds) expect(getAuthoringReference(id), id).toBeDefined()
    }
    expect(searchAuthoringReference('calculation', 2)).toHaveLength(2)
    expect(searchAuthoringReference('')).toEqual([])
    expect(getAuthoringReference('missing')).toBeUndefined()
    expect(getAuthoringReference('calculation.declarations')?.content).toContain("declare module 'mathjs'")
  })
})
