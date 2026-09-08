// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { activeCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { evaluateCadScene } from '@/lib/cad/evaluation/evaluator'
import { h } from '@/lib/cad/evaluation/jsx'
import { Material } from '@/lib/cad/model/material'

describe('Geometry preview without a Catalog', () => {
  it('evaluates an unassigned Material role without requiring model definitions', () => {
    expect(() => activeCatalogRuntimeSlice()).toThrow(/Catalog API data is unavailable/u)
    const preview = evaluateCadScene(h('box', { id: 'preview', size: [1, 2, 3] }))
    expect(preview.parts).toHaveLength(1)
    expect(preview.parts[0].materialRole).toBe('body')
    expect(preview.parts[0].material).toBeUndefined()
    expect(() => activeCatalogRuntimeSlice()).toThrow(/Catalog API data is unavailable/u)
  })

  it.each([undefined, '#336699'])('previews an explicit model-less Material with color %s', (color) => {
    expect(() => activeCatalogRuntimeSlice()).toThrow(/Catalog API data is unavailable/u)
    const material = color === undefined ? new Material('preview') : new Material('preview', { color })
    const preview = evaluateCadScene(
      h(() => h('box', { id: 'body', size: [1, 2, 3] }), { id: 'preview', materials: { body: material } }),
    )
    expect(preview.parts).toHaveLength(1)
    expect(preview.parts[0].material).toEqual({ name: 'preview', models: {}, ...(color ? { color } : {}) })
    expect(() => activeCatalogRuntimeSlice()).toThrow(/Catalog API data is unavailable/u)
  })
})
