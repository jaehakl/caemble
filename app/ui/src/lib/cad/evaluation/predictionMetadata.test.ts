// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { evaluateCadMetadata, evaluateCadScene } from './evaluator'
import { canonicalGeometrySceneDraft } from './canonical'
import { cadElementDefinitions } from './registry'
import { h } from './jsx'
import { resolveBoxGridGeometry, validateDetectorBox } from '../simulation/boxGrid'
import type { KernelOutputRequest, KernelTaskConfig } from '../simulation/kernelContract'

afterEach(() => vi.restoreAllMocks())

it('preserves component, array, transform, Boolean and group identities without creating any solid or surface mesh', () => {
  const component = ({ width }: Record<string, unknown>) => h('box', { size: [width, 2, 3] })
  const root = [
    h(
      'array',
      { id: 'copies', shape: [2, 1, 1], period: [3, 0, 0], inject: { width: [[[1]], [[2]]] } },
      h(component, { id: 'probe', width: 1 }),
    ),
    h('subtract', { id: 'cut' }, h('box', { size: [2, 2, 2] }), h('box', { size: [1, 1, 3] })),
    h('union', { id: 'joined' }, h('box', { size: [1, 1, 1] }), h('box', { size: [1, 1, 1], position: [0.5, 0, 0] })),
    h('intersect', { id: 'intersection' }, h('box', { size: [1, 1, 1] }), h('box', { size: [2, 2, 2] })),
    h(
      'rotate',
      { id: 'rotated', axis: [0, 0, 1], angle: 0.4 },
      h('box', { size: [2, 3, 4], scale: [2, 1, 1], position: [1, 2, 3] }),
    ),
  ]
  const groups = {
    geometryGroup: { probes: ['copies'], rotated: ['rotated'] },
    surfaceGroup: { face: ['cut.box/surface/0'] },
  }
  const expected = canonicalGeometrySceneDraft(evaluateCadScene(root, groups, 'Experiment', 'mm'))
  for (const definition of cadElementDefinitions) {
    if (definition.kind !== 'primitive') continue
    vi.spyOn(definition, 'createGeometry').mockImplementation(() => {
      throw new Error('Unexpected solid build')
    })
    vi.spyOn(definition, 'createSurfaces').mockImplementation(() => {
      throw new Error('Unexpected tessellation')
    })
  }
  expect(evaluateCadMetadata(root, groups, 'Experiment', 'mm')).toEqual(expected)
})

it('resolves current BoxGrid dimensions and transforms identically to full evaluation', () => {
  const output: KernelOutputRequest = {
    key: 'field',
    methodId: 'field',
    target: ['experiment.geometry.probe'],
    parameters: { gridShape: [2, 3, 1] },
  }
  for (const width of [1, 4]) {
    const root = h('box', {
      id: 'probe',
      size: [width, 2, 3],
      position: [2, 3, 4],
      rotation: [0.2, 0.1, 0.3],
      scale: [2, 3, 4],
    })
    const groups = { geometryGroup: { probe: ['probe'] } }
    const full = canonicalGeometrySceneDraft(evaluateCadScene(root, groups, 'Experiment', 'mm'))
    const metadata = evaluateCadMetadata(root, groups, 'Experiment', 'mm')
    const grid = resolveBoxGridGeometry(output, { experiment: metadata, task: metadata }, 'm')
    expect(grid).toEqual(resolveBoxGridGeometry(output, { experiment: full, task: full }, 'm'))
    expect(grid.size[0]).toBeCloseTo((width * 2) / 1000)
  }
})

it('validates detector surfaces from metadata without polygon indices', () => {
  const metadata = evaluateCadMetadata(
    h('box', { id: 'detector', size: [2, 4, 6] }),
    {
      geometryGroup: { detector: ['detector'] },
      surfaceGroup: { face: ['detector/surface/5'] },
    },
    'Experiment',
    'mm',
  )
  const output: KernelOutputRequest = {
    key: 'power',
    methodId: 'power',
    target: ['experiment.geometry.detector'],
    parameters: { gridShape: [2, 4, 1], surface: 'experiment.surface.face' },
  }
  const config: KernelTaskConfig = {
    parameters: {},
    outputs: [output],
    initializations: [{ methodId: 'ray.domain', target: ['experiment.geometry.detector'], parameters: {} }],
    boundaryConditions: [{ methodId: 'ray.absorbing-detector', target: ['experiment.surface.face'], parameters: {} }],
  }
  const grid = {
    ...resolveBoxGridGeometry(output, { experiment: metadata, task: metadata }, 'mm'),
    origin: [-1, -2, 2.9] as const,
    size: [2, 4, 0.2] as const,
  }
  expect(() => validateDetectorBox(output, grid, metadata, config)).not.toThrow()
  expect(() => validateDetectorBox(output, { ...grid, origin: [-1, -2, 3] }, metadata, config)).toThrow(/z-cell center/)
})
