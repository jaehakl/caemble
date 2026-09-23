import { expect, it } from 'vitest'
import { cameraPoseSchema, durableViewerSettings, experimentPresentationSchema } from './viewerDefaults'

it('keeps valid display settings independently and excludes transient and malformed values', () => {
  expect(
    durableViewerSettings(
      Object.entries({
        '@workspace:xrayEnabled': true,
        '@workspace:pickMode': 'body',
        'busy:actual': true,
        'signal:box.geometryOpacity': 0.4,
        'signal:box.speed': -2,
        'signal:box.axes': ['x', 'y'],
        'signal:box.reduce': { frequency: { method: 'median' } },
        'signal:box.bins': undefined,
        'signal:mesh.view': { component: 0 },
        'signal:box.fixed': [2, 1],
      }),
    ),
  ).toEqual({
    '@workspace:xrayEnabled': true,
    'signal:box.geometryOpacity': 0.4,
    'signal:box.axes': ['x', 'y'],
    'signal:box.reduce': { frequency: { method: 'median' } },
  })
})

it('validates camera geometry and preserves defaults after a deleted Measurement clears its reference', () => {
  const camera = { position: [3, 4, 5], target: [0, 0, 0], up: [0, 0, 1], fov: 0.8 }
  expect(cameraPoseSchema.safeParse(camera).success).toBe(true)
  expect(cameraPoseSchema.safeParse({ ...camera, up: [0, 0, 0] }).success).toBe(false)
  expect(cameraPoseSchema.safeParse({ ...camera, fov: Infinity }).success).toBe(false)
  const presentation = {
    id: 7,
    initial_measurement_id: null,
    thumbnail_url: null,
    viewer_defaults: { version: 1, selectedResult: 'signal', settings: {}, camera },
  }
  expect(experimentPresentationSchema.parse(presentation)).toEqual(presentation)
})

it('restores vector and tensor component choices while rejecting malformed tensor pairs', () => {
  expect(
    durableViewerSettings(
      Object.entries({
        'vector:box.component': 'magnitude',
        'squared:box.component': 'magnitudeSquared',
        'tensor:box.component': { tensor: ['arrows', 'y'] },
        'invalid:box.component': { tensor: ['arrows', 'invalid'] },
        'two-arrows:box.component': { tensor: ['arrows', 'arrows'] },
      }),
    ),
  ).toEqual({
    'vector:box.component': 'magnitude',
    'squared:box.component': 'magnitudeSquared',
    'tensor:box.component': { tensor: ['arrows', 'y'] },
  })
})
