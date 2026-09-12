import { describe, expect, it } from 'vitest'
import { BOX_GRID_AXES, type BoxGridData } from '@/contracts/boxGrid'
import { createDataTensor, createDataTensorAccessor } from '@/lib/cad/model/dataTensor'
import type { RecordedDataRule } from '@/lib/cad/model/descriptor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { createCalculationInput } from '@/lib/calculation/input'
import { assertCalculationInput } from '@/lib/calculation/validation'
import { fieldScalar, fieldSlice, structuredField } from '@/features/viewer/viewer/structuredField'
import { predictedRecordedData, predictionRecordedRowSample } from './data'
import { buildPredictionKnnModel, predictWithKnn, selectPredictionCohort } from './knn'
import { assertPredictionRecordedMemory } from './usePredictionModels'

function output(
  name: string,
  values: readonly number[],
  frequency = 0,
  modal = false,
  geometry: Partial<BoxGridData> = {},
) {
  const boxGrid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components: ['scalar'],
    channels: ['amplitude', 'phase'],
    channelUnits: ['Pa', 'rad'],
    origin: [0, 0, 0],
    size: [2, 4, 6],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    gridShape: [1, 1, 1],
    lengthUnit: 'm',
    source: 'task',
    rootId: 'box',
    ...(modal ? { frequencyKind: 'modal' as const } : {}),
    ...geometry,
  }
  const ticks = [[1], [2], [3], [0], [frequency], ['amplitude', 'phase'], ['scalar']]
  const axes = BOX_GRID_AXES.map((name, index) => ({
    name,
    ...(index < 3 || (index === 4 && modal) ? {} : { ticks: ticks[index] }),
    ...(index < 3
      ? { unit: 'm' as const, quantityKind: 'space.Length' }
      : index === 3
        ? { unit: 's' as const, quantityKind: 'time.Time' }
        : index === 4
          ? { unit: 'Hz' as const, quantityKind: 'time.Frequency' }
          : {}),
  }))
  const result: RecordedDataRule['result'] & { tensorOrder: number } = {
    dtype: 'float64',
    unit: 'Pa',
    quantityKind: 'mechanics.Pressure',
    tensorOrder: 0,
    axes,
    boxGrid,
  }
  const rule = {
    label: name,
    target: [],
    methodId: 'fixture',
    parameters: {},
    result,
  } satisfies RecordedDataRule
  const tensor = createDataTensor(rule.result, {
    value: varsTensorFromFlat(values, [1, 1, 1, 1, 1, 2, 1]),
    boxGrid,
    axes: ticks.map((ticks) => ({ ticks })),
  })
  const row = {
    name,
    measurement_id: 1,
    experiment_record_id: 1,
    dtype: 'float64',
    tensor_order: 0,
    quantity_kind: null,
    data_schema: rule.result,
    data: tensor,
  }
  return { boxGrid, rule, tensor, row, sample: predictionRecordedRowSample(row) }
}

const scalar = (value: number) => ({ layout: { key: 'x', dtype: 'float64' as const, shape: [] }, values: [value] })

describe('Box Grid consumer contract', () => {
  it('requires seven explicit axes and preserves geometry in Calculation input', () => {
    const record = output('field', [2, 0])
    const input = createCalculationInput([record.rule], { field: record.tensor })
    expect(input.field.shape).toEqual([1, 1, 1, 1, 1, 2, 1])
    expect(input.field.axes).toHaveLength(7)
    expect(input.field.boxGrid).toEqual(record.boxGrid)
    expect(() => assertCalculationInput({ field: { ...input.field, boxGrid: {} } })).toThrow()
    expect(() => assertCalculationInput({ field: { ...input.field, shape: [2] } })).toThrow()
    expect(() => assertCalculationInput({ field: { ...input.field, dtype: 'string', data: ['a', 'b'] } })).toThrow()
  })

  it('averages polar data in Cartesian coordinates and restores candidate Box coordinates', () => {
    const first = output('field', [1, Math.PI - 0.1])
    const second = output('field', [1, -Math.PI + 0.1])
    const model = buildPredictionKnnModel({
      direction: 'forward',
      fingerprint: 'polar',
      inputKeys: ['x'],
      outputKeys: ['field'],
      k: 2,
      weighting: 'uniform',
      rows: [
        { measurementId: 1, inputs: [scalar(0)], outputs: [first.sample] },
        { measurementId: 2, inputs: [scalar(1)], outputs: [second.sample] },
      ],
    })
    const predicted = predictWithKnn(model, [scalar(0.5)], 'polar')
    const candidate = { ...first.boxGrid, origin: [10, 20, 30] as const, size: [4, 8, 12] as const }
    const restored = predictedRecordedData(predicted.output, [first.rule], undefined, { field: candidate })
    const input = createCalculationInput([first.rule], restored)
    expect(input.field.data[0]).toBeCloseTo(Math.cos(0.1))
    expect(Math.abs(input.field.data[1])).toBeCloseTo(Math.PI)
    expect(input.field.boxGrid.origin).toEqual([10, 20, 30])
    expect(input.field.axes[0].ticks).toEqual([2])
  })

  it('keeps a whole modal group and its eigenfrequency ticks from one nearest measurement', () => {
    const a = output('u', [1, 0], 10, true)
    const b = output('r', [2, Math.PI], 10, true)
    const c = output('u', [8, Math.PI], 20, true)
    const d = output('r', [9, 0], 20, true)
    const model = buildPredictionKnnModel({
      direction: 'forward',
      fingerprint: 'modal',
      inputKeys: ['x'],
      outputKeys: ['u', 'r'],
      k: 1,
      nearestOnly: true,
      rows: [
        { measurementId: 2, inputs: [scalar(0)], outputs: [c.sample, d.sample] },
        { measurementId: 1, inputs: [scalar(0)], outputs: [a.sample, b.sample] },
        { measurementId: 3, inputs: [scalar(1)], outputs: [c.sample, d.sample] },
      ],
    })
    const predicted = predictWithKnn(model, [scalar(0)], 'modal')
    expect(predicted.neighbors).toEqual([{ measurementId: 1, distanceSquared: 0, weight: 1 }])
    const restored = predictedRecordedData(predicted.output, [a.rule, b.rule])
    const input = createCalculationInput([a.rule, b.rule], restored)
    expect(input.u.axes[4].ticks).toEqual([10])
    expect(input.r.axes[4].ticks).toEqual([10])
    expect(input.u.data[0]).toBe(1)
    expect(input.r.data[0]).toBe(2)
  })

  it('keeps stored float32 polar phases inside the canonical interval and clears underflow phase', () => {
    const source = output('field', [1, 0])
    const rule = { ...source.rule, result: { ...source.rule.result, dtype: 'float32' as const } }
    const sample = { layout: { ...source.sample.layout, dtype: 'float32' as const }, values: [-1, 1e-10] }
    const input = createCalculationInput([rule], predictedRecordedData([sample], [rule]))
    expect(input.field.data[1]).toBeLessThan(Math.PI)
    expect(input.field.data[1]).toBeGreaterThanOrEqual(-Math.PI)
    const tiny = createCalculationInput([rule], predictedRecordedData([{ ...sample, values: [1e-50, 1e-50] }], [rule]))
    expect(tiny.field.data).toEqual([0, 0])
    const zero = output('zero', [0, 0])
    expect(
      fieldScalar(structuredField(zero.rule.result, zero.tensor, { kind: 'box-grid' }, 'm'), [0, 0, 0], 0, 0, 'arg'),
    ).toBe(0)
    for (const data of [
      [-1, 0],
      [0, 1],
      [1, Math.PI],
      [1, Math.fround(-Math.PI)],
    ]) {
      expect(() => assertCalculationInput({ field: { ...input.field, data } })).toThrow(/polar channels/)
    }
  })

  it('uses Box relative positions but rejects incompatible sampled frequencies', () => {
    const a = output('field', [1, 0], 10)
    const b = output('field', [2, 0], 10, false, { origin: [5, 0, 0] })
    const c = output('field', [3, 0], 20)
    const cohort = selectPredictionCohort({
      direction: 'forward',
      fingerprint: 'layout',
      inputKeys: ['x'],
      outputKeys: ['field'],
      rows: [a, b, c].map((record, index) => ({
        measurementId: index + 1,
        inputs: [scalar(index)],
        outputs: [record.sample],
      })),
    })
    expect(cohort.summary.includedMeasurementIds).toEqual([1, 2])
    expect(cohort.summary.excluded['layout-mismatch']).toBe(1)
    expect(cohort.summary.diagnostics).toContainEqual(
      expect.objectContaining({ fieldPath: 'boxGridContract', measurementIds: [3] }),
    )
  })

  it('renders a rotated seven-axis field in world space with world components', () => {
    const record = output('field', [3, Math.PI / 2], 20, false, {
      origin: [10, 20, 30],
      rotation: [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
    })
    const field = structuredField(record.rule.result, record.tensor, { kind: 'box-grid' }, 'm')
    expect(field.bounds).toEqual({ min: [6, 20, 30], max: [10, 22, 36] })
    expect(fieldScalar(field, [0, 0, 0], 0, 0, 'im')).toBeCloseTo(3)
    const slice = fieldSlice(field, 'field', 2, 0, 0, 0, 'abs', [0, 3], 1)
    expect(Array.from(slice.geometries[0].positions.slice(0, 3))).toEqual([10, 20, 33])
    expect(createDataTensorAccessor(record.rule.result, record.tensor).shape).toHaveLength(7)
  })

  it('rejects oversized tensors from metadata before their objects are downloaded', () => {
    const record = output('field', [1, 0])
    expect(() =>
      assertPredictionRecordedMemory(
        [{ ...record.row, data: { ...record.tensor, shape: [512, 512, 512, 1, 1, 2, 1] } }],
        1,
      ),
    ).toThrow(/제한/)
  })
})
