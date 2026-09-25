// @vitest-environment node
import path from 'node:path'
import { expect, it } from 'vitest'
import { compileCatalogExample, readCatalogExamples } from '../../../../scripts/catalog-example-support'
import { installCatalogRuntimeSlice } from '../../catalog/runtime'
import { canonicalGeometryScene } from '../evaluation/canonical'
import { executeCompiledDocument, inspectCompiledDocument } from './userModule'

it('maps all 13 normalized particle rows to the original FCC bilayer', async () => {
  const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
  installCatalogRuntimeSlice(catalog)
  const example = examples.find((entry) => entry.key === 'gold-fcc-fresnel')!
  const compiled = compileCatalogExample(example, catalog)
  expect(inspectCompiledDocument(compiled).varsSchema).toEqual({
    particles: { shape: [13, 4], min: 0, max: 1 },
  })
  const variants = [
    ...[0, 0.5, 1].map((value) => Array.from({ length: 13 }, () => [value, value, value, value])),
    Array.from({ length: 13 }, (_, index) => [index / 12, 1 - index / 12, (index % 3) / 2, index / 12]),
  ]
  let nominalIds: string[] | undefined
  for (const particles of variants) {
    const evaluated = executeCompiledDocument(compiled, { particles }, example.sourceBundle.files['simulate.py'])
    const scene = await canonicalGeometryScene(evaluated.scene)
    expect(scene.roots).toHaveLength(13)
    const ids = scene.roots.map((root) => root.id)
    nominalIds ??= ids
    expect(ids).toEqual(nominalIds)
    for (const [index, root] of scene.roots.entries()) {
      let node = root.node
      const matrices: (readonly number[])[] = []
      while (node.kind === 'transform' || node.kind === 'instance') {
        matrices.push(node.matrix)
        node = node.child
      }
      expect(node.kind).toBe('primitive')
      if (node.kind !== 'primitive') throw new Error('Expected a sphere primitive')
      expect(node.primitive).toBe('sphere')
      expect(Number(node.parameters.radius) * 2000).toBeCloseTo(100 + 100 * particles[index][3], 10)
      let center = [0, 0, 0]
      for (const matrix of matrices.reverse()) {
        center = [0, 1, 2].map((row) =>
          center.reduce((sum, value, axis) => sum + matrix[row * 4 + axis] * value, matrix[row * 4 + 3]),
        )
      }
      const size = index < 9 ? 3 : 2
      const localIndex = index < 9 ? index : index - 9
      const expected = [
        (Math.floor(localIndex / size) - (size - 1) / 2) * 0.25,
        ((localIndex % size) - (size - 1) / 2) * 0.25,
        ((index < 9 ? -1 : 1) * 0.25) / (2 * Math.sqrt(2)),
      ]
      for (let axis = 0; axis < 3; axis++) {
        expect(center[axis]).toBeCloseTo(expected[axis] + (100 * particles[index][axis] - 50) / 1000, 12)
      }
    }
  }
}, 30_000)
