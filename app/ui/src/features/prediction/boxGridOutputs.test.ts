import { describe, expect, it } from 'vitest'
import { BOX_GRID_AXES, type BoxGridData } from '@/contracts/boxGrid'
import { createDataTensor, createDataTensorAccessor } from '@/lib/cad/model/dataTensor'
import type { RecordedDataRule } from '@/lib/cad/model/descriptor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { createCalculationInput } from '@/lib/calculation/input'
import { assertCalculationInput } from '@/lib/calculation/validation'
import { fieldScalar, fieldSlice, structuredField } from '@/features/viewer/viewer/structuredField'
import { predictedRecordedData } from './data'
import type { PredictionTensorSample } from './types'

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
  const sample: PredictionTensorSample = {
    layout: {
      key: name,
      dtype: 'float64',
      shape: tensor.shape,
      axes: axes.map((axis, index) => ({ ...axis, ticks: ticks[index] })),
      boxGrid,
      frequencyOutput: modal,
    },
    values: [values[0] * Math.cos(values[1]), values[0] * Math.sin(values[1]), ...(modal ? [frequency] : [])],
  }
  return { boxGrid, rule, tensor, row, sample }
}

describe('Box Grid consumer contract', () => {
  it('rejects unresolved candidate result metadata before constructing predicted records', () => {
    const record = output('field', [2, 0])
    const rule = {
      ...record.rule,
      result: {
        ...record.rule.result,
        metadata: {
          pressureOffset: { dtype: 'float64' as const, quantityKind: 'Pressure', unit: 'Pa' },
        },
      },
    }
    expect(() => predictedRecordedData([record.sample], [rule])).toThrow(
      'Prediction cannot resolve declared result metadata',
    )
    expect(() => predictedRecordedData([record.sample], [record.rule])).not.toThrow()
  })
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

  it('restores polar remote values and the current Candidate Box coordinates', () => {
    const first = output('field', [1, Math.PI - 0.1])
    const predicted = { output: [{ ...first.sample, values: [-Math.cos(0.1), 0] }] }
    const candidate = { ...first.boxGrid, origin: [10, 20, 30] as const, size: [4, 8, 12] as const }
    const restored = predictedRecordedData(predicted.output, [first.rule], undefined, { field: candidate })
    const input = createCalculationInput([first.rule], restored)
    expect(input.field.data[0]).toBeCloseTo(Math.cos(0.1))
    expect(Math.abs(input.field.data[1])).toBeCloseTo(Math.PI)
    expect(input.field.boxGrid.origin).toEqual([10, 20, 30])
    expect(input.field.axes[0].ticks).toEqual([2])
  })

  it('preserves a remote modal group and its predicted eigenfrequency ticks', () => {
    const a = output('u', [1, 0], 10, true)
    const b = output('r', [2, Math.PI], 10, true)
    const predicted = { output: [a.sample, b.sample] }
    const restored = predictedRecordedData(predicted.output, [a.rule, b.rule])
    const input = createCalculationInput([a.rule, b.rule], restored)
    expect(input.u.axes[4].ticks).toEqual([10])
    expect(input.r.axes[4].ticks).toEqual([10])
    expect(input.u.data[0]).toBe(1)
    expect(input.r.data[0]).toBe(2)
  })

  it('rejects different Candidate output meaning while allowing relative spatial cell correspondence', () => {
    const record = output('field', [1, 0])
    for (const difference of [
      { sampling: 'cell-average' as const },
      { channelUnits: ['m', 'rad'] },
      { components: ['displacement'] },
      { frequencyKind: 'modal' as const },
    ]) {
      expect(() =>
        predictedRecordedData([record.sample], [record.rule], undefined, {
          field: { ...record.boxGrid, ...difference },
        }),
      ).toThrow(/Candidate BoxGrid .*모델 출력 계약/)
    }
    expect(() =>
      predictedRecordedData([record.sample], [record.rule], undefined, {
        field: { ...record.boxGrid, gridShape: [2, 1, 1] },
      }),
    ).toThrow(/shape/)
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
    const slice = fieldSlice(field, 'field', 2, 0, 0, 0, 'abs', [0, 3])
    expect(Array.from(slice.geometries[0].positions.slice(0, 3))).toEqual([10, 20, 33])
    expect(createDataTensorAccessor(record.rule.result, record.tensor).shape).toHaveLength(7)
  })
})
