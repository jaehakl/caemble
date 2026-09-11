import { describe, expect, it } from 'vitest'
import {
  automaticDeformationScale,
  matchMeshDisplacement,
  meshFrameAtTime,
  meshHistoryBounds,
  meshHistoryRange,
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
