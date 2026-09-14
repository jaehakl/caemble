import { describe, expect, it } from 'vitest'
import {
  automaticDeformationScale,
  matchMeshDisplacement,
  meshFrameAtTime,
  meshHistoryBounds,
  meshHistoryRange,
  meshHarmonicAtPhase,
  meshHarmonicBounds,
  meshHarmonicRange,
} from './meshDeformation'
import { createMeshFieldRenderData, type RecordedMeshField } from './meshFields'

const field: RecordedMeshField = {
  label: 'arbitrary',
  identity: 'domain',
  task: 'solid',
  coordinateSpace: 'experiment',
  nodeIds: new Int32Array([10, 20, 30, 40]),
  lengthUnit: 'mm',
  valueUnit: 'm',
  quantity: 'kinematics.Displacement',
  valueKind: 'displacement',
  location: 'node',
  points: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  cells: new Uint32Array([0, 1, 2, 3]),
  values: new Float64Array([0, 0, 0, 0.001, 0, 0, 0, 0, 0, 0, 0, 0]),
  componentCount: 3,
  components: ['X', 'Y', 'Z'],
  boundaryFaces: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  boundaryCells: new Uint32Array(4),
  cellRegions: new Uint32Array([0]),
  regionIds: ['body'],
  supportNodes: new Uint32Array(),
  loadPoints: new Float64Array(),
  loadVectors: new Float64Array(),
}

describe('mesh deformation', () => {
  it('selects exact frequency coordinates and reconstructs signed phase states without changing the spectrum', () => {
    const spectrum = {
      ...field,
      values: new Float64Array([...field.values, ...field.values.map((value) => value * 2)]),
      spectrum: {
        frequencies: new Float64Array([91, 37]),
        imaginaryValues: new Float64Array([
          ...field.values.map((value) => value * 3),
          ...field.values.map((value) => value * 4),
        ]),
      },
    }
    expect(meshHarmonicAtPhase(spectrum, 37, 0).values[3]).toBe(0.002)
    expect(meshHarmonicAtPhase(spectrum, 37, 90).values[3]).toBeCloseTo(-0.004)
    expect(meshHarmonicAtPhase(spectrum, 37, 180).values[3]).toBeCloseTo(-0.002)
    expect(meshHarmonicAtPhase(spectrum, 37, 360).values[3]).toBeCloseTo(0.002)
    expect(() => meshHarmonicAtPhase(spectrum, 38, 0)).toThrow('보간 없이')
    expect(spectrum.values[15]).toBe(0.002)
    expect(meshHarmonicRange(spectrum, 37, 0)).toEqual([-Math.hypot(0.002, 0.004), Math.hypot(0.002, 0.004)])
    expect(automaticDeformationScale(spectrum, 37)).toBeCloseTo((Math.sqrt(300) * 0.1) / Math.sqrt(20))
    expect(meshHarmonicBounds(spectrum, 37, 1, 'mm').max[0]).toBeCloseTo(10 + Math.sqrt(20))
    expect(matchMeshDisplacement(field, spectrum)).toBeUndefined()
    expect(matchMeshDisplacement(spectrum, spectrum)?.spectrum?.imaginaryValues).toEqual(
      spectrum.spectrum.imaginaryValues,
    )
  })
  it('derives von Mises from instantaneous real stress instead of a complex magnitude', () => {
    const stress: RecordedMeshField = {
      ...field,
      valueKind: 'stress',
      location: 'cell',
      componentCount: 6,
      valueUnit: 'Pa',
      values: new Float64Array(6),
      spectrum: { frequencies: new Float64Array([17]), imaginaryValues: new Float64Array([0, 0, 0, 5, 0, 0]) },
    }
    const view = {
      component: 'vonMises' as const,
      deformationScale: 0,
      wireframe: false,
      overlays: false,
      clipAxis: -1 as const,
      clipFraction: 0.5,
    }
    expect(createMeshFieldRenderData(meshHarmonicAtPhase(stress, 17, 0), view).maximum).toBe(0)
    expect(createMeshFieldRenderData(meshHarmonicAtPhase(stress, 17, 90), view).maximum).toBeCloseTo(Math.sqrt(75))
    expect(meshHarmonicRange(stress, 17, 'vonMises')[1]).toBeCloseTo(Math.sqrt(75))
  })
  it('interpolates vector components before section magnitude and fixes harmonic cuts to reference bounds', () => {
    const opposing = { ...field, values: new Float64Array([-0.001, 0, 0, 0.001, 0, 0, -0.001, 0, 0, -0.001, 0, 0]) }
    const view = {
      component: 'magnitude' as const,
      deformationScale: 0,
      wireframe: false,
      overlays: false,
      clipAxis: 0 as const,
      clipFraction: 0.5,
      referenceClip: true,
    }
    const rendered = createMeshFieldRenderData(opposing, view, 'mm', undefined, [0, 0.001])
    const cap = rendered.geometries
      .flatMap((geometry) =>
        Array.from({ length: geometry.positions.length / 3 }, (_, index) => ({
          point: [...geometry.positions.slice(index * 3, index * 3 + 3)],
          color: [...geometry.colors.slice(index * 4, index * 4 + 3)],
        })),
      )
      .find(({ point }) => point[0] === 5 && point[1] === 0 && point[2] === 0)
    expect(cap?.color).toEqual([0, 0, 1])
    expect(createMeshFieldRenderData(field, { ...view, deformationScale: 2 }, 'mm').cut).toBe(5)
  })
  it('converts physical displacement units without magnifying the legend', () => {
    const result = createMeshFieldRenderData(field, {
      component: 'magnitude',
      deformationScale: 2,
      wireframe: true,
      overlays: false,
      clipAxis: -1,
      clipFraction: 0.5,
    })
    expect(result.bounds.max[0]).toBe(12)
    expect(result.maximum).toBe(0.001)
  })
  it('uses the maximum across every frame for magnification and range', () => {
    const history = {
      ...field,
      historyValues: new Float64Array([...field.values, ...field.values.map((value) => value * 2)]),
    }
    expect(automaticDeformationScale(history)).toBeCloseTo((Math.sqrt(300) * 0.1) / 2)
    expect(meshHistoryRange(history, 'magnitude')).toEqual([0, 0.002])
    expect(meshHistoryBounds(history, 1, 'mm').max[0]).toBe(12)
    expect(automaticDeformationScale({ ...field, values: new Float64Array(12) })).toBe(1)
  })
  it('maps node IDs and rejects foreign tasks, topology and incomplete provenance', () => {
    const candidate = {
      ...field,
      nodeIds: new Int32Array([20, 10, 30, 40]),
      points: new Float64Array([10, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 10]),
      cells: new Uint32Array([1, 0, 2, 3]),
      values: new Float64Array([0.001, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    }
    expect(matchMeshDisplacement(field, candidate)?.values).toEqual(field.values)
    expect(matchMeshDisplacement(field, { ...candidate, task: 'other' })).toBeUndefined()
    expect(matchMeshDisplacement(field, { ...candidate, cells: field.cells })).toBeUndefined()
    expect(matchMeshDisplacement({ ...field, nodeIds: undefined }, candidate)).toBeUndefined()
  })
  it('selects recorded frames at irregular times without interpolation', () => {
    const times = new Float64Array([0, 0.1, 0.8, 1])
    expect(meshFrameAtTime(times, 0.79)).toBe(1)
    expect(meshFrameAtTime(times, 0.8)).toBe(2)
    expect(meshFrameAtTime(times, 2)).toBe(3)
  })
})
