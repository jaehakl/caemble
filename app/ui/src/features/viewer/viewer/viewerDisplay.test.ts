import { expect, it } from 'vitest'
import { initialViewerDisplay, initializeVisualizations } from './viewerDisplay'
import { visualizationData } from './visualizationData'
import { viewerDisplayFixture } from '@/features/cae-workbench/viewer/viewerDisplay.fixture'
import { combineMeshes } from './ViewerSceneLayers'

it('initializes each type once, retains explicit none, and migrates v1 selection and overlays', () => {
  const contracts = visualizationData(viewerDisplayFixture().visualizations!).contracts
  expect(initializeVisualizations(contracts, {})).toEqual({
    'mesh-field': '@visualizations.sample.field',
    polyline: '@visualizations.sample.rays',
  })
  expect(initializeVisualizations(contracts, { polyline: '' }).polyline).toBe('')
  const legacy = {
    version: 1 as const,
    selectedResult: 'signal',
    settings: { 'signal:box.geometryOpacity': 0.3, 'signal:overlay': ['missing', '@visualizations.sample.rays'] },
    camera: null,
  }
  expect(initialViewerDisplay(legacy)).toMatchObject({ geometry: 0.5, output: 'signal' })
  expect(initializeVisualizations(contracts, {}, legacy)).toEqual({
    'mesh-field': '',
    polyline: '@visualizations.sample.rays',
  })
  expect(initialViewerDisplay({ ...legacy, settings: { 'signal:box.overlay': false } }).geometry).toBe(0.9)
  expect(initialViewerDisplay({ ...legacy, settings: { 'signal:particles.geometry': false } }).geometry).toBe(0.9)
  expect(initialViewerDisplay({ ...legacy, settings: { '@workspace:xrayEnabled': true } }).geometry).toBe(0.9)
})

it('unions all mesh bounds without mutating per-layer meshes', () => {
  const first = { geometries: [], bounds: { min: [-3, 0, 2], max: [1, 2, 4] } }
  const second = { geometries: [], bounds: { min: [0, -2, 1], max: [6, 7, 3] } }
  expect(combineMeshes([{ mesh: first }, { mesh: second }])?.bounds).toEqual({ min: [-3, -2, 1], max: [6, 7, 4] })
  expect(first.bounds.min).toEqual([-3, 0, 2])
})

it('restores shared Output settings from the chart, falling back to old 3D values', async () => {
  const { createViewerSettings } = await import('./comparisonSettings')
  const settings = createViewerSettings({
    version: 2,
    geometryMode: 0,
    selectedOutput: 'signal',
    visualizations: {},
    camera: null,
    settings: {
      'signal:box.kind': 'line',
      'signal:box.axes': ['time'],
      'signal:box.component': 1,
      'signal:box.fixed': [0, 20],
      'signal@output-chart:box.component': 2,
    },
  })
  expect(settings.values.get('@workspace:geometryMode')).toBe(0.9)
  expect(settings.values.get('signal@output-chart:box.kind')).toBe('line')
  expect(settings.values.get('signal@output-chart:box.component')).toBe(2)
  expect(settings.values.get('signal@output-chart:box.fixed')).toEqual([0, 20])
  expect(settings.values.has('signal@output-space:box.component')).toBe(false)
  expect(settings.values.has('signal@output-space:box.axes')).toBe(false)
  const spaceOnly = createViewerSettings({
    version: 2,
    geometryMode: 0.9,
    selectedOutput: 'signal',
    visualizations: {},
    camera: null,
    settings: { 'signal@output-space:box.representation': 'phase' },
  })
  expect(spaceOnly.values.get('signal@output-chart:box.representation')).toBe('phase')
  expect(spaceOnly.values.has('signal@output-space:box.representation')).toBe(false)
})
