import { describe, expect, it, vi } from 'vitest'
import {
  CadModelError,
  normalizeDataValue,
  normalizeDataValueDescriptor,
  normalizeRawScalar,
  resolveMaterialVariables,
  Mat,
  Material,
  Structure,
  evaluateWithVars,
  vars,
  type Geometry,
  type GeometryAttributes,
  type DataDType,
  type DataValueDescriptor,
  type QuantityKindName,
} from './core'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { componentShapeForTensorOrder } from '../../quantitykind/runtime'

function assertQuantityMetadataTypes() {
  const quantityKind = 'Length' as const satisfies QuantityKindName
  const floatData: DataValueDescriptor = {
    dtype: 'float64',
    axes: [{ length: 1 }],
    value: [1],
    unit: 'm',
    quantityKind,
  }
  const integerData: DataValueDescriptor = {
    dtype: 'int32',
    axes: [{ length: 1 }],
    value: [1],
  }
  const vectorData: DataValueDescriptor = {
    dtype: 'float64',
    value: [1, 2, 3],
    unit: 'N',
    quantityKind: 'mechanics.Force',
    basis: identityCartesianBasis,
  }
  const vectorWithoutBasis: DataValueDescriptor = {
    dtype: 'float64',
    value: [1, 2, 3],
    unit: 'N',
    quantityKind: 'mechanics.Force',
  }
  // @ts-expect-error unknown Quantity Kind names must be rejected
  const unknownQuantityKind: QuantityKindName = 'NotAQuantityKind'
  // @ts-expect-error float descriptors require Quantity Kind metadata
  const missingQuantityKind: DataValueDescriptor = { dtype: 'float64', value: 1, unit: 'm' }
  const integerWithMetadata: DataValueDescriptor = {
    dtype: 'int32',
    axes: [{ length: 1 }],
    value: [1],
    unit: 'm',
    // @ts-expect-error non-float descriptors must not declare Quantity Kind metadata
    quantityKind: 'Length',
  }
  void [
    floatData,
    integerData,
    vectorData,
    vectorWithoutBasis,
    unknownQuantityKind,
    missingQuantityKind,
    integerWithMetadata,
  ]
}
void assertQuantityMetadataTypes

function createStructure() {
  return new Structure({
    lengthUnit: 'mm',
    geometry: () => null,
    varsSchema: {
      width: { min: 10, max: 30 },
      offset: {
        min: -2,
        max: [2, 3],
      },
      fixed: {
        min: [
          [1, 2],
          [3, 4],
        ],
        max: [
          [1, 2],
          [3, 4],
        ],
      },
    },
  })
}

describe('Structure vars and groups', () => {
  it('randomizes omitted vars and applies validated partial vars', () => {
    const resolved = createStructure().resolveVars({ width: 25, offset: [0, 1] })

    expect(resolved).toEqual({
      width: 25,
      offset: [0, 1],
      fixed: [
        [1, 2],
        [3, 4],
      ],
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.fixed)).toBe(true)
  })

  it('rejects unknown, malformed, non-finite, and out-of-range vars', () => {
    const structure = createStructure()

    expect(() => structure.resolveVars({ extra: 1 })).toThrow('Unknown Structure var: extra')
    expect(() => structure.resolveVars({ offset: [1] })).toThrow('must have shape [2]')
    expect(() => structure.resolveVars({ fixed: [[1, 2], [3]] })).toThrow('must have shape [2]')
    expect(() => structure.resolveVars({ width: Number.NaN })).toThrow('must be a finite number')
    expect(() => structure.resolveVars({ width: 31 })).toThrow('less than or equal to 30')
  })

  it('infers shapes and rejects invalid or legacy bounds', () => {
    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            invalid: { min: [0, 3], max: [2, 2] },
          },
        }),
    ).toThrow('min greater than max')

    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            invalid: { min: 0 } as never,
          },
        }),
    ).toThrow('must define both min and max')

    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            legacy: { shape: [], default: 1, min: 0, max: 2 } as never,
          },
        }),
    ).toThrow('shape is not supported')
    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            ragged: { min: [[0], [1, 2]], max: 3 },
          },
        }),
    ).toThrow('must be a rectangular tensor')
    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            mismatch: { min: [0, 0], max: [[1, 1]] },
          },
        }),
    ).toThrow('must have shape [2]')
    expect(
      () =>
        new Structure({
          lengthUnit: 'mm',
          geometry: () => null,
          varsSchema: {
            nonFinite: { min: Number.NaN, max: 1 },
          },
        }),
    ).toThrow('must contain only finite numbers')
  })

  it('generates deterministic seeded vars within scalar-broadcast and tensor bounds', () => {
    const structure = createStructure()
    const first = structure.randomVars(260713)
    const second = structure.randomVars(260713)

    expect(first).toEqual(second)
    expect(first.width).toBeGreaterThanOrEqual(10)
    expect(first.width).toBeLessThanOrEqual(30)
    expect((first.offset as readonly number[])[0]).toBeGreaterThanOrEqual(-2)
    expect((first.offset as readonly number[])[0]).toBeLessThanOrEqual(2)
    expect((first.offset as readonly number[])[1]).toBeLessThanOrEqual(3)
    expect(first.fixed).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('creates a new unseeded realization per instance and lets partial vars win', () => {
    const random = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.8)

    try {
      const structure = createStructure()
      const first = structure.resolveVars()
      const second = structure.resolveVars({ width: 27 })

      expect(first.width).toBe(12)
      expect(second.width).toBe(27)
      expect(first.offset).not.toEqual(second.offset)
    } finally {
      random.mockRestore()
    }
  })

  it('normalizes, deduplicates, and deeply freezes Structure groups', () => {
    const structure = new Structure({
      lengthUnit: 'mm',
      geometry: () => null,
      varsSchema: {},
      geometryGroup: {
        ' 본체 ': [' assembly.body ', 'assembly.body', 'missing'],
      },
      surfaceGroup: { 접촉면: [] },
    })

    expect(structure.geometryGroup).toEqual({ 본체: ['assembly.body', 'missing'] })
    expect(structure.surfaceGroup).toEqual({ 접촉면: [] })
    expect(Object.isFrozen(structure.geometryGroup)).toBe(true)
    expect(Object.isFrozen(structure.geometryGroup.본체)).toBe(true)
    expect(Object.isFrozen(structure.surfaceGroup.접촉면)).toBe(true)
    expect(createStructure().geometryGroup).toEqual({})
  })

  it('rejects malformed Structure group maps, names, and members', () => {
    const options = { geometry: () => null, varsSchema: {} }

    expect(() => new Structure({ lengthUnit: 'mm', ...options, geometryGroup: [] as never })).toThrow(
      'geometryGroup must be an object',
    )
    expect(() => new Structure({ lengthUnit: 'mm', ...options, geometryGroup: { ' ': [] } })).toThrow(
      'group names must not be empty',
    )
    expect(
      () => new Structure({ lengthUnit: 'mm', ...options, geometryGroup: { duplicate: [], ' duplicate ': [] } }),
    ).toThrow('duplicated after trimming')
    expect(
      () => new Structure({ lengthUnit: 'mm', ...options, geometryGroup: { invalid: 'assembly' as never } }),
    ).toThrow('must be an array')
    expect(() => new Structure({ lengthUnit: 'mm', ...options, surfaceGroup: { invalid: [''] } })).toThrow(
      'must be a non-empty string',
    )
    expect(() => new Structure({ lengthUnit: 'mm', ...options, surfaceGroup: { invalid: [1 as never] } })).toThrow(
      'must be a non-empty string',
    )
  })
})

describe('Data values and Structure units', () => {
  it('normalizes raw scalars and dtype descriptors and rejects unsupported forms', () => {
    const normalizeParameter = (parameter: unknown) =>
      typeof parameter === 'object' && parameter !== null && !Array.isArray(parameter)
        ? normalizeDataValueDescriptor(parameter, 'Parameter')
        : normalizeRawScalar(parameter, 'Parameter')

    expect(normalizeParameter(true)).toBe(true)
    expect(normalizeParameter('text')).toBe('text')
    expect(normalizeParameter(12)).toBe(12)
    expect(normalizeParameter({ dtype: 'bool', value: false })).toEqual({ dtype: 'bool', value: false })
    expect(normalizeParameter({ dtype: 'string', value: 'value' })).toEqual({ dtype: 'string', value: 'value' })
    expect(normalizeParameter({ dtype: 'int64', value: 4 })).toEqual({ dtype: 'int64', value: 4 })
    expect(
      normalizeParameter({
        dtype: 'float64',
        value: 4,
        unit: '{fraction}',
        quantityKind: 'DimensionlessRatio',
      }),
    ).toEqual({
      dtype: 'float64',
      value: 4,
      unit: '{fraction}',
      quantityKind: 'DimensionlessRatio',
    })
    expect(
      normalizeParameter({ dtype: 'float64', value: 1, unit: 'mV', quantityKind: 'electromagnetism.Voltage' }),
    ).toEqual({
      dtype: 'float64',
      value: 1,
      unit: 'mV',
      quantityKind: 'electromagnetism.Voltage',
    })

    ;[
      1.25,
      () => 1,
      null,
      [1, 2],
      { nested: true },
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      { dtype: 'bool', value: 1 },
      { dtype: 'string', value: false },
      { dtype: 'int64', value: 1.5 },
      { dtype: 'float64', value: Number.NEGATIVE_INFINITY, unit: '{fraction}', quantityKind: 'DimensionlessRatio' },
      { dtype: 'float64', value: 1 },
      { dtype: 'float64', value: 1, unit: 'not-a-unit', quantityKind: 'electromagnetism.Voltage' },
      { dtype: 'float64', value: 1, unit: 'mV', quantityKind: 'NotAQuantityKind' },
      { dtype: 'float64', value: 1, unit: 'm', quantityKind: 'electromagnetism.Voltage' },
      { dtype: 'float64', value: 1, unit: '{fraction}', quantityKind: 'fluidDynamics.APIGravity' },
    ].forEach((parameter) => {
      expect(() => normalizeParameter(parameter)).toThrow(CadModelError)
    })
  })

  it('validates every dtype without rounding accepted values', () => {
    const valid: readonly [DataDType, unknown][] = [
      ['bool', [true, false]],
      ['string', ['left', 'right']],
      ['int8', [-128, 127]],
      ['int16', [-32768, 32767]],
      ['int32', [-2147483648, 2147483647]],
      ['int64', [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]],
      ['uint8', [0, 255]],
      ['uint16', [0, 65535]],
      ['uint32', [0, 4294967295]],
      ['uint64', [0, Number.MAX_SAFE_INTEGER]],
      ['float16', [-65504, 65504]],
      ['float32', [Math.fround(-1.25), Math.fround(1.25)]],
      ['float64', [-Number.MAX_VALUE, Number.MAX_VALUE]],
    ]

    valid.forEach(([dtype, value]) => {
      const descriptor = normalizeDataValueDescriptor({
        dtype,
        axes: [{ length: 2 }],
        value,
        ...(dtype.startsWith('float') ? { unit: '{fraction}', quantityKind: 'DimensionlessRatio' } : {}),
      })
      expect(descriptor.value).toEqual(value)
      expect(descriptor.axes?.[0]).toEqual({ length: 2, name: 'axis 0', ticks: [0, 1] })
    })

    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'int8',
        axes: [{ length: 1 }],
        value: [128],
      }),
    ).toThrow('must be a int8 safe integer')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'float16',
        axes: [{ length: 1 }],
        value: [65505],
        unit: '{fraction}',
        quantityKind: 'DimensionlessRatio',
      }),
    ).toThrow('finite float16 value')
  })

  it('uses axis lengths as the outer shape and rejects empty, malformed, or ragged data', () => {
    const descriptor = normalizeDataValueDescriptor({
      dtype: 'int32',
      axes: [
        { length: 2, name: 'row' },
        { length: 3, name: 'column', ticks: ['a', 'b', 'c'] },
      ],
      value: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    })

    expect(descriptor.axes).toEqual([
      { length: 2, name: 'row', ticks: [0, 1] },
      { length: 3, name: 'column', ticks: ['a', 'b', 'c'] },
    ])
    expect(Object.isFrozen(descriptor.axes?.[0].ticks)).toBe(true)
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'int32',
        axes: [],
        value: 1,
      }),
    ).toThrow('axes must be omitted')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'int32',
        axes: [{ length: 0 }],
        value: [],
      }),
    ).toThrow('length must be a positive safe integer')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'int32',
        axes: [{ length: 2, ticks: [0] }],
        value: [1, 2],
      }),
    ).toThrow('ticks has length 1; expected 2')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'int32',
        axes: [{ length: 2 }, { length: 2 }],
        value: [[1, 2], [3]],
      }),
    ).toThrow('ragged')
  })

  it('requires a valid UCUM lengthUnit', () => {
    expect(() => new Structure({ geometry: () => null, varsSchema: {} } as never)).toThrow('Structure lengthUnit')
    expect(() => new Structure({ lengthUnit: 's', geometry: () => null, varsSchema: {} })).toThrow(
      'cannot convert s to m',
    )
    expect(new Structure({ lengthUnit: 'cm', geometry: () => null, varsSchema: {} }).lengthUnit).toBe('cm')
  })
})

describe('Material and global vars', () => {
  it('supports every Material constructor overload', () => {
    expect(new Material('Al')).toMatchObject({ name: 'Al', variables: {} })
    expect(
      new Material('Al', {
        'general.mass_density': {
          dtype: 'float64',
          value: 2.7,
          errorRate: 0,
          unit: 'g.cm-3',
        },
      }),
    ).toMatchObject({
      name: 'Al',
      variables: {
        'general.mass_density': {
          dtype: 'float64',
          value: 2.7,
          errorRate: 0,
          unit: 'g.cm-3',
          quantityKind: 'MassDensity',
        },
      },
    })
    expect(new Material('Al', 'Kittel/1988')).toMatchObject({
      name: 'Al',
      source: 'Kittel',
      version: '1988',
      variables: {},
    })
    expect(
      new Material('Al', 'Kittel/1988', {
        'general.mass_density': {
          dtype: 'float64',
          value: 2.7,
          errorRate: 0,
          unit: 'g.cm-3',
        },
      }),
    ).toMatchObject({
      name: 'Al',
      source: 'Kittel',
      version: '1988',
      variables: {
        'general.mass_density': {
          dtype: 'float64',
          value: 2.7,
          errorRate: 0,
          unit: 'g.cm-3',
          quantityKind: 'MassDensity',
        },
      },
    })
    expect(new Material('Al').variables).not.toHaveProperty('color')
  })

  it('builds frozen square matrices from diagonal, off-diagonal, and size inputs', () => {
    expect(Mat(4)).toEqual([
      [4, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
    ])
    expect(Mat(4, 2)).toEqual([
      [4, 2, 2],
      [2, 4, 2],
      [2, 2, 4],
    ])
    expect(Mat(4, 2, 2)).toEqual([
      [4, 2],
      [2, 4],
    ])
    const identityScaled = Mat(4, 0, 2)
    expect(identityScaled).toEqual([
      [4, 0],
      [0, 4],
    ])
    expect(Object.isFrozen(identityScaled)).toBe(true)
    expect(identityScaled.every(Object.isFrozen)).toBe(true)

    expect(() => Mat(Number.NaN)).toThrow('Mat diagonal must be a finite number')
    expect(() => Mat(1, Number.POSITIVE_INFINITY)).toThrow('Mat offDiagonal must be a finite number')
    expect(() => Mat(1, 0, 0)).toThrow('Mat size must be a positive safe integer')
    expect(() => Mat(1, 0, 1.5)).toThrow('Mat size must be a positive safe integer')
  })

  it('combines outer and Quantity Kind component shapes and validates Cartesian bases', () => {
    const vector = normalizeDataValueDescriptor({
      dtype: 'float64',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      value: [1, 2, 3],
    })
    const matrixSamples = normalizeDataValueDescriptor({
      dtype: 'float64',
      axes: [{ length: 2 }],
      unit: 'S.m-1',
      quantityKind: 'electromagnetism.ElectricConductivity',
      value: [
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        [
          [2, 0, 0],
          [0, 2, 0],
          [0, 0, 2],
        ],
      ],
    })

    expect(vector).toMatchObject({ value: [1, 2, 3] })
    expect(vector).not.toHaveProperty('axes')
    expect(vector.basis).toEqual(identityCartesianBasis)
    expect(matrixSamples.value).toHaveLength(2)
    expect(Object.isFrozen(vector.basis)).toBe(true)
    expect(Object.isFrozen(vector.basis?.[0])).toBe(true)

    expect(
      normalizeDataValueDescriptor({
        dtype: 'float64',
        unit: 'A.m-2',
        quantityKind: 'electromagnetism.ElectricCurrentDensity',
        value: [1, 2, 3],
      }).basis,
    ).toEqual(identityCartesianBasis)
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'float64',
        unit: 'A.m-2',
        quantityKind: 'electromagnetism.ElectricCurrentDensity',
        basis: identityCartesianBasis,
        value: 1,
      }),
    ).toThrow('actual shape []; expected shape [3]')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'float64',
        axes: [{ length: 2 }],
        unit: 'A.m-2',
        quantityKind: 'electromagnetism.ElectricCurrentDensity',
        basis: identityCartesianBasis,
        value: [
          [1, 2, 3],
          [4, 5],
        ],
      }),
    ).toThrow('actual shape [2, ragged [3] | [2]]; expected shape [2,3]')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'float64',
        unit: 'S.m-1',
        quantityKind: 'electromagnetism.ElectricConductivity',
        basis: identityCartesianBasis,
        value: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      }),
    ).toThrow('expected shape [3,3]')
    expect(() =>
      normalizeDataValueDescriptor({
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        basis: identityCartesianBasis,
        value: 1,
      }),
    ).toThrow('basis is not allowed for scalar Quantity Kind electromagnetism.Voltage')
  })

  it('accepts basis tolerance but rejects non-finite, non-orthogonal, and left-handed bases', () => {
    const epsilon = 5e-10
    const descriptor = {
      dtype: 'float64',
      unit: 'N',
      quantityKind: 'mechanics.Force',
      value: [1, 2, 3],
    }
    expect(
      normalizeDataValueDescriptor({
        ...descriptor,
        basis: [
          [1, 0, 0],
          [epsilon, Math.sqrt(1 - epsilon ** 2), 0],
          [0, 0, 1],
        ],
      }),
    ).toMatchObject({ value: [1, 2, 3] })
    expect(() =>
      normalizeDataValueDescriptor({
        ...descriptor,
        basis: [
          [1, 0, 0],
          [0, Number.NaN, 0],
          [0, 0, 1],
        ],
      }),
    ).toThrow('exactly three finite numbers')
    expect(() =>
      normalizeDataValueDescriptor({
        ...descriptor,
        basis: [
          [1, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
        ],
      }),
    ).toThrow('orthonormal Cartesian basis')
    expect(() =>
      normalizeDataValueDescriptor({
        ...descriptor,
        basis: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, -1],
        ],
      }),
    ).toThrow('right-handed Cartesian basis')
  })

  it('handles arbitrary internal order-3 and order-4 component shapes', () => {
    const order3Shape = componentShapeForTensorOrder(3)
    const order4Shape = componentShapeForTensorOrder(4)
    const order3Value = Array.from({ length: 3 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) => Array.from({ length: 3 }, (_, k) => i * 9 + j * 3 + k)),
    )
    const order4Value = Array.from({ length: 3 }, () => order3Value)

    const normalized3 = normalizeDataValue(order3Value, order3Shape, 'float64', 'order3')
    const normalized4 = normalizeDataValue(order4Value, order4Shape, 'float64', 'order4')
    expect(normalized3).toEqual(order3Value)
    expect(normalized4).toEqual(order4Value)
    expect(Object.isFrozen(normalized4)).toBe(true)
    expect(() => normalizeDataValue([order3Value, order3Value], order4Shape, 'float64', 'order4')).toThrow(
      'expected shape [3,3,3,3]',
    )
  })

  it('rejects every legacy descriptor field with a dtype/axes migration error', () => {
    expect(() =>
      normalizeDataValueDescriptor({
        type: 'tensor',
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: 1,
      }),
    ).toThrow('.type is obsolete in the dtype/axes contract; use dtype')
    expect(() =>
      normalizeDataValueDescriptor({
        shape: [1],
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: [1],
      }),
    ).toThrow('.shape is obsolete in the dtype/axes contract; move every outer dimension to axes with a length')
    expect(() =>
      normalizeDataValueDescriptor({
        dimension: 1,
        dtype: 'float64',
        axes: [{ length: 1 }],
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: [1],
      }),
    ).toThrow('.dimension is obsolete in the dtype/axes contract; omit it; outer dimension is axes.length')
    expect(() =>
      normalizeDataValueDescriptor({
        sampleDimension: 1,
        dtype: 'float64',
        axes: [{ length: 1 }],
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: [1],
      } as never),
    ).toThrow('.sampleDimension is obsolete in the dtype/axes contract')
    expect(() =>
      normalizeDataValueDescriptor({
        sampleShape: [1],
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: [1],
      } as never),
    ).toThrow('.sampleShape is obsolete in the dtype/axes contract')
    expect(() =>
      normalizeDataValueDescriptor({
        sampleAxes: [{}],
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
        value: [1],
      } as never),
    ).toThrow('.sampleAxes is obsolete in the dtype/axes contract; use axes')
    expect(
      () =>
        new Material('Legacy', {
          'general.mass_density': {
            dimension: 1,
            dtype: 'float64',
            axes: [{ length: 1 }],
            value: [1],
            errorRate: 0,
            unit: 'kg.m-3',
          } as never,
        }),
    ).toThrow('.dimension is obsolete in the dtype/axes contract; omit it; outer dimension is axes.length')
  })

  it('derives canonical QuantityKinds and enforces scalar, vector, and rank-4 shapes', () => {
    const rank4 = Array.from({ length: 3 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) =>
        Array.from({ length: 3 }, (_, k) => Array.from({ length: 3 }, (_, l) => i + j + k + l)),
      ),
    )
    const material = new Material('Measured', {
      'general.mass_density': {
        dtype: 'float64',
        value: 2700,
        errorRate: 0.2,
        unit: 'kg.m-3',
      },
      'magnetic.remanent_flux_density': {
        dtype: 'float32',
        value: [1.5, -2, 0],
        errorRate: 0.1,
        unit: 'T',
      },
      'mechanical.elastic_stiffness_tensor': {
        dtype: 'float64',
        value: rank4,
        errorRate: 0,
        unit: 'Pa',
      },
    })

    expect(material.variables['general.mass_density']).toMatchObject({
      quantityKind: 'MassDensity',
      value: 2700,
    })
    expect(material.variables['magnetic.remanent_flux_density']).toMatchObject({
      quantityKind: 'electromagnetism.MagneticFluxDensity',
      value: [1.5, -2, 0],
      basis: identityCartesianBasis,
    })
    expect(material.variables['mechanical.elastic_stiffness_tensor']).toMatchObject({
      quantityKind: 'mechanics.ElasticStiffnessTensor',
      basis: identityCartesianBasis,
    })
    expect(Object.isFrozen(material.variables)).toBe(true)
    expect(Object.isFrozen(material.variables['mechanical.elastic_stiffness_tensor']?.value)).toBe(true)

    expect(
      () =>
        new Material('Invalid', {
          'general.mass_density': {
            dtype: 'float64',
            value: 1,
            unit: 'kg.m-3',
            errorRate: 0,
            quantityKind: 'MassDensity',
          } as never,
        }),
    ).toThrow('must contain exactly dtype, value, unit, errorRate')
    expect(
      () =>
        new Material('Invalid', {
          'general.mass_density': {
            dtype: 'float64',
            value: [1],
            unit: 'kg.m-3',
            errorRate: 0,
            axes: [{ length: 1 }],
          } as never,
        }),
    ).toThrow('must contain exactly dtype, value, unit, errorRate')
    expect(
      () =>
        new Material('Invalid', {
          'general.mass_density': { dtype: 'int32', value: 1, unit: 'kg.m-3', errorRate: 0 } as never,
        }),
    ).toThrow('dtype must be a supported float dtype')
    expect(
      () =>
        new Material('Invalid', {
          'general.mass_density': {
            dtype: 'float64',
            value: 1,
            unit: 'kg.m-3',
            errorRate: 0,
            basis: identityCartesianBasis,
          } as never,
        }),
    ).toThrow('basis is not allowed for scalar Quantity Kind MassDensity')
    expect(
      () =>
        new Material('Invalid', {
          'magnetic.remanent_flux_density': {
            dtype: 'float64',
            value: 1,
            unit: 'T',
            errorRate: 0,
          } as never,
        }),
    ).toThrow('actual shape []; expected shape [3]')
    expect(
      () =>
        new Material('Invalid', {
          'mechanical.elastic_stiffness_tensor': {
            dtype: 'float64',
            value: [[1]],
            unit: 'Pa',
            errorRate: 0,
          } as never,
        }),
    ).toThrow('expected shape [3,3,3,3]')

    ;[-0.001, 1, Number.NaN, Number.POSITIVE_INFINITY, '0.1'].forEach((errorRate) => {
      expect(
        () =>
          new Material('Invalid', {
            'general.mass_density': {
              dtype: 'float64',
              value: 1,
              errorRate,
              unit: 'kg.m-3',
            } as never,
          }),
      ).toThrow('errorRate must be a finite number in [0, 1)')
    })
  })

  it('normalizes only enumerated sampled Material relations', () => {
    const material = new Material('Dependent', {
      'model.magnetic_hysteresis.b_h_curve': {
        kind: 'sampled_relation',
        input: {
          unit: 'A.m-1',
          values: [
            [0, 0, 0],
            [100, 0, 0],
          ],
        },
        output: {
          unit: 'T',
          values: [
            [0, 0, 0],
            [1.2, 0, 0],
          ],
        },
      },
      'model.sorption.isotherm': {
        kind: 'sampled_relation',
        input: { unit: '%', values: [0, 100] },
        output: { unit: '{fraction}', values: [0, 0.2] },
      },
    })

    const curve = material.variables['model.magnetic_hysteresis.b_h_curve']!
    expect(curve.input.basis).toEqual(identityCartesianBasis)
    expect(curve.output.basis).toEqual(identityCartesianBasis)
    expect(Object.isFrozen(curve)).toBe(true)
    expect(Object.isFrozen(curve.input.values)).toBe(true)
    expect(Object.isFrozen(curve.input.values[0])).toBe(true)
    expect(material.variables['model.sorption.isotherm']).not.toHaveProperty('input.basis')

    expect(
      () =>
        new Material('Invalid', {
          'model.magnetic_hysteresis.b_h_curve': {
            kind: 'sampled_relation',
            input: { unit: 'A.m-1', values: [[0, 0, 0]] },
            output: { unit: 'T', values: [[0, 0, 0]] },
          },
        }),
    ).toThrow('must contain at least 2 samples')
    expect(
      () =>
        new Material('Invalid', {
          'model.sorption.isotherm': {
            kind: 'sampled_relation',
            input: { unit: '%', values: [0, 50, 100] },
            output: { unit: '{fraction}', values: [0, 0.2] },
          },
        }),
    ).toThrow('input and output must contain the same number of samples')
    expect(
      () =>
        new Material('Invalid', {
          'model.magnetic_hysteresis.b_h_curve': {
            kind: 'sampled_relation',
            input: { unit: 'A.m-1', values: [0, 100] },
            output: {
              unit: 'T',
              values: [
                [0, 0, 0],
                [1.2, 0, 0],
              ],
            },
          },
        } as never),
    ).toThrow('expected shape [3]')
    expect(
      () =>
        new Material('Invalid', {
          'model.sorption.isotherm': {
            kind: 'sampled_relation',
            input: { unit: '%', values: [0, 100], basis: identityCartesianBasis },
            output: { unit: '{fraction}', values: [0, 0.2] },
          },
        } as never),
    ).toThrow('basis is not allowed for scalar Quantity Kind thermodynamics.RelativeHumidity')
    expect(
      () =>
        new Material('Invalid', {
          'model.magnetic_hysteresis.b_h_curve': {
            kind: 'sampled_relation',
            input: {
              unit: 'A.m-1',
              values: [
                [0, 0, 0],
                [100, 0, 0],
              ],
              basis: identityCartesianBasis,
            },
            output: {
              unit: 'T',
              values: [
                [0, 0, 0],
                [1.2, 0, 0],
              ],
              basis: [
                [0, 1, 0],
                [-1, 0, 0],
                [0, 0, 1],
              ],
            },
          },
        } as never),
    ).toThrow('input and output must use the same Cartesian basis')
  })

  it('realizes float values deterministically per evaluation seed and strips error rates', () => {
    const material = new Material('Variable', {
      'general.mass_density': {
        dtype: 'float64',
        value: 100,
        errorRate: 0.1,
        unit: 'kg.m-3',
      },
      'thermal.specific_heat_capacity': {
        dtype: 'float64',
        value: 25,
        errorRate: 0,
        unit: 'J.kg-1.K-1',
      },
      'electrical.conductivity': {
        dtype: 'float64',
        value: [
          [10, 0, 0],
          [0, 20, 0],
          [0, 0, 30],
        ],
        errorRate: 0.2,
        unit: 'S.m-1',
      },
    })
    const materialStructure = new Structure({ lengthUnit: 'mm', geometry: () => null, varsSchema: {} })
    const resolvedVars = materialStructure.resolveVars({}, 1)
    const direct = resolveMaterialVariables(material)
    const first = evaluateWithVars(resolvedVars, () => resolveMaterialVariables(material), 1)
    const replay = evaluateWithVars(resolvedVars, () => resolveMaterialVariables(material), 1)
    const second = evaluateWithVars(resolvedVars, () => resolveMaterialVariables(material), 2)

    expect(direct['general.mass_density']).toEqual({
      dtype: 'float64',
      value: 100,
      unit: 'kg.m-3',
      quantityKind: 'MassDensity',
    })
    expect(first).toEqual(replay)
    expect(second).not.toEqual(first)
    expect(first['general.mass_density']).not.toHaveProperty('errorRate')
    expect(first['electrical.conductivity']).not.toHaveProperty('errorRate')
    expect(material.variables['general.mass_density']).toMatchObject({ value: 100, errorRate: 0.1 })
    expect(first['thermal.specific_heat_capacity']).toEqual({
      dtype: 'float64',
      value: 25,
      unit: 'J.kg-1.K-1',
      quantityKind: 'thermodynamics.SpecificHeatCapacity',
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first['electrical.conductivity'])).toBe(true)

    const scalar = first['general.mass_density'] as { value: number }
    expect(scalar.value).toBeGreaterThanOrEqual(90)
    expect(scalar.value).toBeLessThanOrEqual(110)
    const field = (first['electrical.conductivity'] as { value: readonly (readonly number[])[] }).value
    const multipliers = [field[0][0] / 10, field[1][1] / 20, field[2][2] / 30]
    multipliers.forEach((multiplier) => {
      expect(multiplier).toBeGreaterThanOrEqual(0.8)
      expect(multiplier).toBeLessThanOrEqual(1.2)
    })
    expect(multipliers[0]).toBe(multipliers[1])
  })

  it('applies hierarchical Material error rates and keeps them out of scene variables', () => {
    const defaults = new Material('Default', {
      'general.mass_density': { dtype: 'float32', value: 100, unit: 'kg.m-3' },
    })
    const inherited = new Material('Inherited', {
      errorRate: 0.2,
      'general.mass_density': { dtype: 'float32', value: 100, unit: 'kg.m-3' },
      'thermal.specific_heat_capacity': {
        dtype: 'float32',
        value: 20,
        unit: 'J.kg-1.K-1',
        errorRate: 0,
      },
    })

    expect(defaults.errorRate).toBe(0.001)
    expect(defaults.variables['general.mass_density']?.errorRate).toBe(0.001)
    expect(inherited.errorRate).toBe(0.2)
    expect(inherited.variables).not.toHaveProperty('errorRate')
    expect(inherited.variables['general.mass_density']?.errorRate).toBe(0.2)
    expect(inherited.variables['thermal.specific_heat_capacity']?.errorRate).toBe(0)
    expect(resolveMaterialVariables(inherited)).not.toHaveProperty('errorRate')
  })

  it('rejects a realized float tensor value that exceeds its dtype range', () => {
    const resolvedVars = createStructure().resolveVars({}, 1)
    const material = new Material('Overflow', {
      'general.mass_density': {
        dtype: 'float16',
        value: 65504,
        errorRate: 0.5,
        unit: 'kg.m-3',
      },
    })

    expect(() => evaluateWithVars(resolvedVars, () => resolveMaterialVariables(material), 1)).toThrow(
      'must be a finite float16 value in [-65504, 65504]',
    )
  })

  it('constructs Materials after vars are bound and deeply freezes dtype descriptors', () => {
    const resolvedVars = createStructure().resolveVars({ width: 24 }, 1)
    const source = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    const material = evaluateWithVars(
      resolvedVars,
      () =>
        new Material('Core', 'measured', {
          'general.mass_density': {
            dtype: 'float64',
            value: vars.width as number,
            errorRate: 0,
            unit: 'kg.m-3',
          },
          'electrical.conductivity': {
            dtype: 'float64',
            value: source,
            errorRate: 0,
            unit: 'S.m-1',
          },
        }),
    )

    expect(material.variables).toMatchObject({
      'general.mass_density': { value: 24, quantityKind: 'MassDensity' },
      'electrical.conductivity': {
        value: source,
        quantityKind: 'electromagnetism.ElectricConductivity',
        basis: identityCartesianBasis,
      },
    })
    expect(Object.isFrozen(material.variables)).toBe(true)
    expect(Object.isFrozen(material.variables['electrical.conductivity'])).toBe(true)
    source[0][0] = 99
    expect(material.variables['electrical.conductivity']?.value).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    expect(() => {
      ;(material.variables as Record<string, number>)['general.mass_density'] = 3
    }).toThrow()

    const colored = new Material('SiO2', { color: '#A1B2C3' })
    expect(colored.variables.color).toBe('#a1b2c3')
  })

  it('does not expose global vars outside CAD source evaluation', () => {
    expect(() => vars.width).toThrow(CadModelError)
  })

  it('rejects invalid Material metadata and raw composite values', () => {
    expect(() => new Material('', {})).toThrow('non-empty string')
    expect(() => new Material('Core', ' ')).toThrow('source selector')
    expect(() => new Material('Core', '/v1')).toThrow('source selector')
    expect(() => new Material('Core', 'source/')).toThrow('source selector')
    expect(() => new Material('Core', 'source/v1/extra')).toThrow('source selector')
    expect(() => new Material('Core', { values: [1, 2] } as never)).toThrow(
      'variables.values is not a registered Material catalog key',
    )
    expect(() => new Material('Core', { electricalConductivity: {} } as never)).toThrow(
      'variables.electricalConductivity is not a registered Material catalog key',
    )
    expect(() => new Material('Core', { 'model.arbitrary.curve': {} } as never)).toThrow(
      'variables.model.arbitrary.curve is not a registered Material catalog key',
    )
    expect(() => new Material('Core', { 'general.mass_density': 1.5 } as never)).toThrow(
      'must be a Material property descriptor',
    )
    expect(
      () =>
        new Material('Core', {
          'general.mass_density': {
            dtype: 'float64',
            value: 1.5,
            errorRate: 0,
            unit: 'invalid-unit',
          },
        }),
    ).toThrow('valid case-sensitive UCUM code')
    expect(
      () =>
        new Material('Core', {
          'electrical.conductivity': {
            dtype: 'float64',
            value: Mat(1),
            errorRate: 0,
            unit: 'S/m',
          } as never,
        }),
    ).toThrow('S/m is not applicable to Quantity Kind electromagnetism.ElectricConductivity')
    expect(
      () =>
        new Material('Core', {
          'electrical.conductivity': {
            dtype: 'float64',
            value: 1.5,
            errorRate: 0,
            unit: 'S.m-1',
          } as never,
        }),
    ).toThrow('actual shape []; expected shape [3,3]')
    expect(
      () =>
        new Material('Core', {
          'general.mass_density': { dtype: 'int32', value: 1, errorRate: 0, unit: 'kg.m-3' } as never,
        }),
    ).toThrow('dtype must be a supported float dtype')
    expect(() => new Material('Core', { color: 'blue' })).toThrow('#RRGGBB')
    expect(() => new Material('Core', { errorRate: null } as never)).toThrow('finite number in [0, 1)')
    expect(() => new Material('Core', { errorRate: -0.1 })).toThrow('finite number in [0, 1)')
    expect(() => new Material('Core', { errorRate: 1 })).toThrow('finite number in [0, 1)')
    expect(
      () =>
        new Material('Core', {
          'general.mass_density': {
            dtype: 'float64',
            value: 1,
            unit: 'kg.m-3',
            errorRate: null,
          } as never,
        }),
    ).toThrow('finite number in [0, 1)')
    expect(() => new Material('Core', null as never)).toThrow('plain object')
    expect(() => new Material('Core', 'measured', null as never)).toThrow('plain object')

    const LegacyMaterial = Material as unknown as new (...args: unknown[]) => Material
    expect(() => new LegacyMaterial('Core', {}, '#2563eb')).toThrow('source selector')
  })
})

describe('Geometry types', () => {
  it('combines custom props with shared Geometry attributes', () => {
    type LayoutProps = { gap: number; label: string }
    const attributes: GeometryAttributes<LayoutProps> = {
      id: 'layout',
      gap: 4,
      label: 'core',
      pos: [1, 2, 3],
      rotate: { axis: [0, 0, 1], angle: Math.PI / 4 },
      scale: [1, 2, 1],
    }
    const layout: Geometry<LayoutProps> = (input) => ({
      gap: input.gap,
      label: input.label,
      pos: input.pos,
    })

    expect(layout(attributes)).toEqual({ gap: 4, label: 'core', pos: [1, 2, 3] })
  })
})
