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
  expect(initialViewerDisplay({ ...legacy, settings: { 'signal:box.overlay': false } }).geometry).toBe(0)
  expect(initialViewerDisplay({ ...legacy, settings: { 'signal:particles.geometry': false } }).geometry).toBe(0)
  expect(initialViewerDisplay({ ...legacy, settings: { '@workspace:xrayEnabled': true } }).geometry).toBe(0.9)
})

it('unions all mesh bounds without mutating per-layer meshes', () => {
  const first = { geometries: [], bounds: { min: [-3, 0, 2], max: [1, 2, 4] } }
  const second = { geometries: [], bounds: { min: [0, -2, 1], max: [6, 7, 3] } }
  expect(combineMeshes([{ mesh: first }, { mesh: second }])?.bounds).toEqual({ min: [-3, -2, 1], max: [6, 7, 4] })
  expect(first.bounds.min).toEqual([-3, 0, 2])
})
