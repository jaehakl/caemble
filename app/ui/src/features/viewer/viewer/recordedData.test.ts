import { describe, expect, it } from 'vitest'
import type { RecordedDataRule } from '@/lib/cad'
import { identityCartesianBasis } from '@/lib/quantitykind'
import {
  convertRecordedNumericTicks,
  convertRecordedNumericValue,
  normalizeCadViewerRecordedTensor,
  recordedDisplayUnitOptions,
  resolveCadViewerRecordedData,
} from './recordedData'

function createRule(
  label: string,
  shape: readonly number[],
  dtype: RecordedDataRule['result']['dtype'] = 'float32',
  axes: readonly Readonly<{
    name?: string
    ticks?: readonly (number | string)[]
  }>[] = shape.map((size, index) => ({
    name: `axis ${index}`,
    ...(size === -1 ? {} : { ticks: Array.from({ length: size }, (_, tick) => tick) }),
  })),
): RecordedDataRule {
  return {
    target: ['experiment.geometry.domain'],
    label,
    methodId: 'field.record',
    parameters: {},
    result: {
      dtype,
      ...(axes.length === 0
        ? {}
        : {
            axes: axes.map((axis, index) => ({
              ...(shape[index] === -1 ? {} : { length: shape[index] }),
              ...axis,
            })),
          }),
      ...(dtype.startsWith('float') ? { unit: '{fraction}', quantityKind: 'DimensionlessRatio' } : {}),
    } as RecordedDataRule['result'],
  }
}

describe('CadViewer recordedData normalization', () => {
  it('converts display values and numeric ticks without mutating normalized source data', () => {
    const source = Object.freeze([Object.freeze([1, 2])])
    const converted = convertRecordedNumericValue(source, 'A', 'mA') as readonly (readonly number[])[]
    const temperatures = convertRecordedNumericValue([0, 100], 'Cel', 'K') as readonly number[]

    expect(converted).toEqual([[1_000, 2_000]])
    expect(converted).not.toBe(source)
    expect(converted[0]).not.toBe(source[0])
    expect(source).toEqual([[1, 2]])
    expect(Object.isFrozen(converted)).toBe(true)
    expect(Object.isFrozen(converted[0])).toBe(true)
    expect(temperatures[0]).toBeCloseTo(273.15)
    expect(temperatures[1]).toBeCloseTo(373.15)
    expect(convertRecordedNumericTicks([0, 0.5, 1], 'm', 'mm')).toEqual([0, 500, 1_000])
    expect(convertRecordedNumericValue([[1, 2, 3]], 'A', 'mA', 1)).toEqual([[1_000, 2_000, 3_000]])
    expect(() => convertRecordedNumericValue([0, 0, 0], 'Cel', 'K', 1)).toThrow('must preserve zero')
  })

  it('lists the source unit first and removes incompatible Quantity Kind alternatives', () => {
    const currentUnits = recordedDisplayUnitOptions('electromagnetism.ElectricCurrent', 'A')
    const angularUnits = recordedDisplayUnitOptions('kinematics.AngularAcceleration', '{#}.s-2')

    expect(currentUnits[0]).toBe('A')
    expect(currentUnits).toContain('mA')
    expect(new Set(currentUnits).size).toBe(currentUnits.length)
    expect(angularUnits[0]).toBe('{#}.s-2')
    expect(angularUnits).not.toContain('rad.s-2')
  })

  it('normalizes fixed tensors against the Experiment schema and freezes copies', () => {
    const source = [
      [1, 2, 3],
      [4, 5, 6],
    ]
    const rule = createRule('Layer field', [2, 3], 'float32', [
      { name: 'layer', ticks: ['lower', 'upper'] },
      { name: 'position', ticks: [0, 0.5, 1] },
    ])
    const tensor = normalizeCadViewerRecordedTensor(rule, { value: source })

    expect(tensor).toEqual({
      value: source,
      componentShape: [],
      tensorOrder: 0,
      dtype: 'float32',
      unit: '{fraction}',
      quantityKind: 'DimensionlessRatio',
      axes: [
        { length: 2, name: 'layer', ticks: ['lower', 'upper'] },
        { length: 3, name: 'position', ticks: [0, 0.5, 1] },
      ],
    })
    expect(Object.isFrozen(tensor)).toBe(true)
    expect(Object.isFrozen(tensor.value)).toBe(true)
    expect(Object.isFrozen(tensor.axes)).toBe(true)
    expect(Object.isFrozen(tensor.axes[0].ticks)).toBe(true)
    source[0][0] = 99
    expect((tensor.value as readonly (readonly number[])[])[0][0]).toBe(1)
  })

  it('appends component shape after dynamic shape for vector payloads', () => {
    const rule: RecordedDataRule = {
      target: ['experiment.geometry.domain'],
      label: 'Current density',
      methodId: 'current-density.record',
      parameters: {},
      result: {
        dtype: 'float64',
        unit: 'A.m-2',
        quantityKind: 'electromagnetism.ElectricCurrentDensity',
        basis: identityCartesianBasis,
        axes: [{ name: 'position' }],
      },
    }
    const tensor = normalizeCadViewerRecordedTensor(rule, {
      value: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      axes: [{ ticks: ['a', 'b'] }],
    })

    expect(tensor).toMatchObject({
      componentShape: [3],
      tensorOrder: 1,
      basis: identityCartesianBasis,
      value: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    })
    expect(() =>
      normalizeCadViewerRecordedTensor(rule, {
        value: [
          [1, 2, 3],
          [4, 5],
        ],
      }),
    ).toThrow('expected shape [-1,3]')
    expect(() =>
      normalizeCadViewerRecordedTensor(rule, {
        value: [[1, 2, 3]],
        sampleAxes: [{ ticks: ['a'] }],
      } as never),
    ).toThrow('.sampleAxes is obsolete in the dtype/axes contract; use recordedData["Current density"].axes')
  })

  it('resolves multiple wildcard axes, empty tensors, and result-provided ticks', () => {
    const rule = createRule('Dynamic field', [-1, -1], 'float64', [{ name: 'time' }, { name: 'position' }])
    const tensor = normalizeCadViewerRecordedTensor(rule, {
      value: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      axes: [{ ticks: ['t0', 't1', 't2'] }, { ticks: [10, 20] }],
    })
    const empty = normalizeCadViewerRecordedTensor(rule, { value: [] })

    expect(tensor.axes).toEqual([
      { length: 3, name: 'time', ticks: ['t0', 't1', 't2'] },
      { length: 2, name: 'position', ticks: [10, 20] },
    ])
    expect(empty.axes).toEqual([
      { length: 0, name: 'time', ticks: [] },
      { length: 0, name: 'position', ticks: [] },
    ])
  })

  it('uses 0-based wildcard ticks and validates fixed and dynamic payload axes', () => {
    const dynamic = createRule('Dynamic profile', [-1])
    expect(normalizeCadViewerRecordedTensor(dynamic, { value: [1, 2, 3] }).axes[0].ticks).toEqual([0, 1, 2])
    expect(() =>
      normalizeCadViewerRecordedTensor(dynamic, {
        value: [1, 2, 3],
        axes: [{ ticks: ['a', 'b'] }],
      }),
    ).toThrow('ticks has length 2; expected actual axis length 3')

    const fixed = createRule('Fixed profile', [2], 'float32', [{ name: 'x', ticks: ['a', 'b'] }])
    expect(
      normalizeCadViewerRecordedTensor(fixed, {
        value: [1, 2],
        axes: [{ ticks: ['a', 'b'] }],
      }).axes[0].ticks,
    ).toEqual(['a', 'b'])
    expect(() =>
      normalizeCadViewerRecordedTensor(fixed, {
        value: [1, 2],
        axes: [{ ticks: ['b', 'a'] }],
      }),
    ).toThrow('does not match Experiment schema ticks')
    expect(() =>
      normalizeCadViewerRecordedTensor(fixed, {
        value: [1, 2],
        axes: [{ name: 'x' }],
      }),
    ).toThrow('may contain only ticks')
  })

  it('reports actual and expected shapes, ragged values, dtype errors, and invalid envelopes', () => {
    const rule = createRule('Profile', [-1, 2], 'int16')

    expect(() => normalizeCadViewerRecordedTensor(rule, { value: [[1, 2], [3]] })).toThrow(
      'actual shape [2, ragged [2] | [1]]; expected shape [-1,2]',
    )
    expect(() => normalizeCadViewerRecordedTensor(rule, { value: [[1, 40000]] })).toThrow(
      'must be a int16 safe integer',
    )
    expect(() => normalizeCadViewerRecordedTensor(rule, [[1, 2]])).toThrow('must be a plain object containing value')
    expect(() => normalizeCadViewerRecordedTensor(rule, { value: [[1, 2]], shape: [1, 2] })).toThrow(
      '.shape is obsolete in the dtype/axes contract',
    )
  })

  it('keeps missing rules empty and isolates unknown labels and per-rule errors', () => {
    const scalar = createRule('Average', [], 'float64', [])
    const profile = createRule('Profile', [2])
    const resolved = resolveCadViewerRecordedData([scalar, profile], {
      Average: { value: 0.5 },
      Profile: { value: [1] },
      Extra: { value: 1 },
    })

    expect(resolved.unknownLabels).toEqual(['Extra'])
    expect(resolved.entries[0].tensor?.value).toBe(0.5)
    expect(resolved.entries[1].tensor).toBeNull()
    expect(resolved.entries[1].error).toContain('actual shape [1]; expected shape [2]')

    const missing = resolveCadViewerRecordedData([scalar, profile], undefined)
    expect(missing.entries.every((entry) => entry.tensor === null && entry.error === null)).toBe(true)
    expect(resolveCadViewerRecordedData([scalar], []).error).toBe(
      'recordedData must be a plain object keyed by recorded rule label.',
    )
  })
})
