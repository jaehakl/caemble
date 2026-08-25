import { describe, expect, it } from 'vitest'
import type { DataSchema, RecordedData, RecordedDataRule } from './descriptor'
import { parseRayPathBundles, RAY_PATH_EVENT_NAMES } from './rayPaths'

const prefix = '@caemble/ray-paths@1/primary/'
const schemas = {
  vertices: {
    dtype: 'float32',
    unit: 'm',
    quantityKind: 'Length',
    axes: [{ name: 'vertex' }, { name: 'coordinate', length: 3, ticks: ['x', 'y', 'z'] }],
    tensorOrder: 0,
  },
  'path-offsets': { dtype: 'uint32', axes: [{ name: 'path boundary' }], tensorOrder: 0 },
  'segment-power': {
    dtype: 'float32',
    unit: 'W',
    quantityKind: 'optics.RadiantFlux',
    axes: [{ name: 'segment' }],
    tensorOrder: 0,
  },
  'path-wavelength': {
    dtype: 'float32',
    unit: 'm',
    quantityKind: 'Wavelength',
    axes: [{ name: 'path' }],
    tensorOrder: 0,
  },
  'segment-event': { dtype: 'uint8', axes: [{ name: 'segment' }], tensorOrder: 0 },
} as const

function fixture() {
  const rules = Object.entries(schemas).map(([name, result]) => ({
    target: [],
    label: `${prefix}${name}`,
    methodId: 'test',
    parameters: {},
    result: result as DataSchema,
  })) satisfies RecordedDataRule[]
  const axis = [{ implicitOrdinal: true as const }]
  const recordedData = {
    [`${prefix}vertices`]: {
      shape: [5, 3],
      axes: [axis[0], { ticks: ['x', 'y', 'z'] }],
      storage: {
        kind: 'inline',
        value: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [0, 1, 0],
          [0, 2, 0],
        ],
      },
    },
    [`${prefix}path-offsets`]: {
      shape: [3],
      axes: axis,
      storage: { kind: 'inline', value: [0, 3, 5] },
    },
    [`${prefix}segment-power`]: {
      shape: [3],
      axes: axis,
      storage: { kind: 'inline', value: [1, 0.5, 0.25] },
    },
    [`${prefix}path-wavelength`]: {
      shape: [2],
      axes: axis,
      storage: { kind: 'inline', value: [500e-9, 650e-9] },
    },
    [`${prefix}segment-event`]: {
      shape: [3],
      axes: axis,
      storage: { kind: 'inline', value: [2, 3, 4] },
    },
  } satisfies RecordedData
  return { recordedData, rules }
}

describe('ray-path RecordedData bundle', () => {
  it('parses the five-member contract into typed buffers', () => {
    const [bundle] = parseRayPathBundles(fixture().rules, fixture().recordedData)
    expect(bundle).toMatchObject({ id: 'primary', pathCount: 2, segmentCount: 3 })
    expect(bundle.vertices).toBeInstanceOf(Float32Array)
    expect(bundle.pathOffsets).toEqual(new Uint32Array([0, 3, 5]))
    expect(bundle.segmentEvent).toEqual(new Uint8Array([2, 3, 4]))
    expect(RAY_PATH_EVENT_NAMES[bundle.segmentEvent[0]]).toBe('scattering')
  })

  it('rejects incomplete, inconsistent, and unknown-event bundles', () => {
    const { recordedData, rules } = fixture()
    expect(() => parseRayPathBundles(rules.slice(0, 4), recordedData)).toThrow(/all five/)
    expect(() =>
      parseRayPathBundles(rules, {
        ...recordedData,
        [`${prefix}path-offsets`]: {
          shape: [3],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: [0, 34, 36] },
        },
      }),
    ).toThrow(/offsets must start at 0 and end at the vertex count/)
    expect(() =>
      parseRayPathBundles(rules, {
        ...recordedData,
        [`${prefix}segment-event`]: {
          shape: [3],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: [1, 11, 7] },
        },
      }),
    ).toThrow(/unknown event/)
  })

  it('rejects paths with more than 32 segments', () => {
    const { recordedData, rules } = fixture()
    const vertices = Array.from({ length: 34 }, (_, index) => [index, 0, 0])
    expect(() =>
      parseRayPathBundles(rules, {
        ...recordedData,
        [`${prefix}vertices`]: {
          shape: [34, 3],
          axes: [{ implicitOrdinal: true }, { ticks: ['x', 'y', 'z'] }],
          storage: { kind: 'inline', value: vertices },
        },
        [`${prefix}path-offsets`]: {
          shape: [2],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: [0, 34] },
        },
        [`${prefix}segment-power`]: {
          shape: [33],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: Array(33).fill(1) },
        },
        [`${prefix}path-wavelength`]: {
          shape: [1],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: [500e-9] },
        },
        [`${prefix}segment-event`]: {
          shape: [33],
          axes: [{ implicitOrdinal: true }],
          storage: { kind: 'inline', value: Array(33).fill(0) },
        },
      }),
    ).toThrow(/1 to 32 segments/)
  })
})
