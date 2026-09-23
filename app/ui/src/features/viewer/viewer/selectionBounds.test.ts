import { primitives } from '@jscad/modeling'
import { expect, it } from 'vitest'
import type { JscadViewerLayer } from './model'
import { resolveCadViewerSelection, selectedCadViewerBounds, type CadViewerSelectionQuery } from './selection'
import { scaleViewerLayers } from './sourceLayers'

const query = (
  value: string,
  kind: 'geometry' | 'surface' = 'geometry',
  match: 'exact' | 'local' = 'exact',
): CadViewerSelectionQuery => ({
  kind,
  match,
  origin: 'code',
  scope: { source: 'experiment' },
  value,
})

const layer: JscadViewerLayer = {
  source: 'experiment',
  lengthUnit: 'mm',
  parts: [
    {
      id: 'left',
      geometry: primitives.cuboid({ center: [1000, 0, 0], size: [200, 100, 100] }),
      materialRole: 'body',
      surfaces: [{ id: 'face', surfaceIndex: 0, label: 'Face', polygonIndices: [0] }],
    },
    {
      id: 'right',
      geometry: primitives.cuboid({ center: [2000, 0, 0], size: [200, 100, 100] }),
      materialRole: 'body',
      surfaces: [],
    },
    {
      id: 'remote',
      geometry: primitives.cuboid({ center: [10000, 0, 0], size: [200, 100, 100] }),
      materialRole: 'body',
      surfaces: [],
    },
  ],
  tree: {
    key: 'root',
    label: 'Geometry',
    children: [
      {
        key: 'parent',
        label: 'Assembly',
        globalId: 'assembly',
        geometryIds: ['left', 'right'],
        children: [
          {
            key: 'left',
            label: 'Left',
            globalId: 'assembly.left',
            geometryId: 'left',
            geometryIds: ['left'],
            children: [],
          },
          {
            key: 'right',
            label: 'Right',
            globalId: 'assembly.right',
            geometryId: 'right',
            geometryIds: ['right'],
            children: [],
          },
        ],
      },
      {
        key: 'remote',
        label: 'Other',
        globalId: 'remote',
        geometryId: 'remote',
        geometryIds: ['remote'],
        children: [],
      },
    ],
  },
}

it('unions child parts of an exact parent selection in display units', () => {
  const layers = scaleViewerLayers([layer], 'm')
  const selected = query('assembly')
  expect(selectedCadViewerBounds(layers, selected, resolveCadViewerSelection(layers, selected))).toEqual([
    [0.9, -0.05, -0.05],
    [2.1, 0.05, 0.05],
  ])
  const local = query('assembly', 'geometry', 'local')
  expect(selectedCadViewerBounds(layers, local, resolveCadViewerSelection(layers, local))).toEqual([
    [0.9, -0.05, -0.05],
    [2.1, 0.05, 0.05],
  ])
})

it('keeps a separate exact match out of the first selected parent bounds', () => {
  const duplicate: JscadViewerLayer = {
    ...layer,
    tree: {
      ...layer.tree,
      children: [layer.tree.children[0], { ...layer.tree.children[1], globalId: 'assembly' }],
    },
  }
  const selected = query('assembly')
  expect(resolveCadViewerSelection([duplicate], selected)).toHaveLength(3)
  expect(selectedCadViewerBounds([duplicate], selected, resolveCadViewerSelection([duplicate], selected))).toEqual([
    [900, -50, -50],
    [2100, 50, 50],
  ])
})

it('uses the whole owning Geometry for a Surface and only the first separate match', () => {
  const surface = query('face', 'surface')
  expect(selectedCadViewerBounds([layer], surface, resolveCadViewerSelection([layer], surface))).toEqual([
    [900, -50, -50],
    [1100, 50, 50],
  ])
  const local = query('right', 'geometry', 'local')
  const duplicate: JscadViewerLayer = {
    ...layer,
    parts: [
      ...layer.parts,
      { id: 'another', geometry: primitives.cuboid({ center: [20000, 0, 0] }), materialRole: 'body', surfaces: [] },
    ],
    tree: {
      ...layer.tree,
      children: [
        ...layer.tree.children,
        {
          key: 'another',
          label: 'Right',
          globalId: 'another.right',
          geometryId: 'another',
          geometryIds: ['another'],
          children: [],
        },
      ],
    },
  }
  expect(selectedCadViewerBounds([duplicate], local, resolveCadViewerSelection([duplicate], local))).toEqual([
    [19999, -1, -1],
    [20001, 1, 1],
  ])
})

it('returns no selected bounds when selection is cleared or unmatched', () => {
  expect(selectedCadViewerBounds([layer], null, [])).toBeNull()
  const missing = query('missing')
  expect(selectedCadViewerBounds([layer], missing, resolveCadViewerSelection([layer], missing))).toBeNull()
})
