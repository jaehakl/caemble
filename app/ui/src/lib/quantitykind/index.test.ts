import { createUcumService } from '@fhir-toolkit/ucum'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CadModelError } from '../cad/model/errors'
import { identityCartesianBasis } from './identityBasis'
import { opaqueQuantityKindNames, quantityKindData, quantityKindDomains } from './data'
import {
  QuantityKind,
  type ApplicableUnit,
  type QuantityKindComponentValue,
  type QuantityKindDefinition,
  type QuantityKindDomain,
  type QuantityKindName,
  type QuantityKindNameForDomain,
} from './index'
import {
  componentShapeForTensorOrder,
  normalizeQuantityMetadata,
  transformQuantityComponents,
  transformQuantityValue,
} from './runtime'

const addedBaseNames = new Set([
  'CapacitancePerArea',
  'ElectricPotentialPerTemperature',
  'FlowResistivity',
  'PiezoelectricChargeCoefficient',
  'PiezoelectricVoltageCoefficient',
  'PiezoelectricStressCoefficient',
  'PyroelectricCoefficient',
  'PiezoresistiveCoefficient',
  'ElectrostrictionCoefficient',
  'MagnetoelectricCoefficient',
  'StiffnessPerArea',
  'ThermalResistancePerArea',
  'ElasticComplianceTensor',
  'ElasticStiffnessTensor',
  'StressTensor',
])

function assertCompileTimeContracts() {
  // @ts-expect-error seconds are not an applicable Length unit
  QuantityKind.Length.transform(1, 's', 'm')
  // @ts-expect-error domain-specific legacy names are not QuantityKind names
  const legacyName: QuantityKindName = 'Stress'
  // @ts-expect-error domain-specific legacy properties are absent
  QuantityKind.Stress.tensorOrder()
  const mechanicsName: QuantityKindNameForDomain<'mechanics'> = 'mechanics.Stress'
  // @ts-expect-error a general QuantityKind is not owned by mechanics
  const wrongDomain: QuantityKindNameForDomain<'mechanics'> = 'Length'
  void [legacyName, mechanicsName, wrongDomain]
}
void assertCompileTimeContracts

describe('QuantityKind', () => {
  it('contains exactly 1,216 unique concrete definitions split across the fixed physical domains', () => {
    const entries = Object.entries(quantityKindData)
    const baseNames = entries.map(([name, entry]) =>
      entry.domain === 'general' ? name : name.slice(entry.domain.length + 1),
    )

    expect(entries).toHaveLength(1_216)
    expect(new Set(baseNames)).toHaveLength(1_216)
    expect(quantityKindDomains).toEqual([
      'general',
      'geometry',
      'kinematics',
      'mechanics',
      'fluidDynamics',
      'thermodynamics',
      'transport',
      'electromagnetism',
      'coupledPhenomena',
      'optics',
      'acoustics',
      'chemistry',
      'materials',
      'atomicNuclear',
      'lifeSciences',
      'earthSpace',
      'informationComputing',
      'economicsOperations',
    ])
    expect(Object.isFrozen(quantityKindDomains)).toBe(true)
    expect(Object.isFrozen(quantityKindData)).toBe(true)
    for (const removedName of [
      'Capacity',
      'LineicQuantity',
      'PressureBasedQuantity',
      'Unknown',
      'economicsOperations.Asset',
      'informationComputing.StochasticProcess',
      'mechanics.GeneralizedCoordinate',
      'mechanics.GeneralizedForce',
      'mechanics.GeneralizedMomentum',
      'mechanics.GeneralizedVelocity',
      'thermodynamics.TemperatureBasedQuantity',
      'lifeSciences.VisionThresholds',
      'lifeSciences.GustatoryThreshold',
      'lifeSciences.TouchThresholds',
      'informationComputing.SignalDetectionThreshold',
      'earthSpace.PressureBurningRateConstant',
      'electromagnetism.MotorConstant',
      'optics.PlanckFunction',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(quantityKindData, removedName)).toBe(false)
    }

    for (const [name, entry] of entries) {
      const baseName = entry.domain === 'general' ? name : name.slice(entry.domain.length + 1)
      const expectedName = entry.domain === 'general' ? baseName : `${entry.domain}.${baseName}`
      expect(name).toBe(expectedName)
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.applicableUnits)).toBe(true)
      expect(Number.isSafeInteger(entry.tensorOrder)).toBe(true)
      expect(entry.tensorOrder).toBeGreaterThanOrEqual(0)
      expect(entry.tensorOrder).toBeLessThanOrEqual(4)
    }

    const preservedBaseNames = baseNames.filter((name) => !addedBaseNames.has(name)).sort()
    expect(preservedBaseNames).toHaveLength(1_201)
    const preservedNameChecksum = [...preservedBaseNames.join('\n')].reduce(
      (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0,
      2_166_136_261,
    )
    expect(preservedNameChecksum).toBe(3_464_130_834)
    expect(baseNames.filter((name) => addedBaseNames.has(name))).toHaveLength(15)
  })

  it('exposes one flat API with physical-domain and domain-name types', () => {
    const entries = Object.values(QuantityKind)

    expect(entries).toHaveLength(1_216)
    expect(new Set(entries.map(({ name }) => name))).toHaveLength(1_216)
    for (const [name, entry] of Object.entries(QuantityKind)) expect(entry.name).toBe(name)
    expect(QuantityKind['mechanics.CENTER-OF-MASS'].name).toBe('mechanics.CENTER-OF-MASS')
    expect(Object.isFrozen(QuantityKind)).toBe(true)
    expect(Object.isFrozen(QuantityKind.Length)).toBe(true)
    expect(QuantityKind.Length.domain()).toBe('general')
    expect(QuantityKind['mechanics.Stress'].domain()).toBe('mechanics')
    expect(Object.prototype.hasOwnProperty.call(QuantityKind, 'Stress')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(QuantityKind, 'ElectricConductivity')).toBe(false)
    expect(() => normalizeQuantityMetadata({ unit: 'Pa', quantityKind: 'Stress' }, 'Legacy stress')).toThrow(
      'must be a known Quantity Kind name',
    )
    expect(() =>
      normalizeQuantityMetadata(
        {
          unit: 'S.m-1',
          quantityKind: 'ElectricConductivity',
        },
        'Legacy conductivity',
      ),
    ).toThrow('must be a known Quantity Kind name')

    expectTypeOf(QuantityKind.Length).toMatchTypeOf<QuantityKindDefinition<'Length'>>()
    expectTypeOf(QuantityKind['mechanics.Stress'].domain()).toEqualTypeOf<'mechanics'>()
    expectTypeOf<QuantityKindDomain>().toEqualTypeOf<(typeof quantityKindDomains)[number]>()
    expectTypeOf<ApplicableUnit<'fluidDynamics.APIGravity'>>().toEqualTypeOf<'1'>()
  })

  it('preserves representative scalar, vector, and matrix orders', () => {
    expect(QuantityKind.Length.componentShape()).toEqual([])
    expect(QuantityKind['mechanics.Force'].componentShape()).toEqual([3])
    expect(QuantityKind['electromagnetism.ElectricConductivity'].componentShape()).toEqual([3, 3])
    expect(QuantityKind['mechanics.Stress'].tensorOrder()).toBe(0)
    expect(QuantityKind['mechanics.StressTensor'].componentShape()).toEqual([3, 3])
    expect(QuantityKind['mechanics.Strain'].tensorOrder()).toBe(2)
    expect(QuantityKind['electromagnetism.ElectricQuadrupoleMoment'].tensorOrder()).toBe(2)
    expect(QuantityKind.AngularFrequency.tensorOrder()).toBe(0)
    expect(QuantityKind['mechanics.BendingMomentOfForce'].tensorOrder()).toBe(0)
    expect(QuantityKind['earthSpace.HorizontalVelocity'].tensorOrder()).toBe(0)
    expect(QuantityKind['atomicNuclear.ParticleCurrent'].tensorOrder()).toBe(0)
    expect(QuantityKind.Pressure.tensorOrder()).toBe(0)
    expect(QuantityKind['geometry.Tilt'].tensorOrder()).toBe(0)

    expectTypeOf(QuantityKind['mechanics.Force'].componentShape()).toEqualTypeOf<readonly [3]>()
    expectTypeOf(QuantityKind['electromagnetism.ElectricConductivity'].componentShape()).toEqualTypeOf<
      readonly [3, 3]
    >()
  })

  it('supports the new scalar and rank-1 through rank-4 definitions without Voigt contraction', () => {
    expect(QuantityKind['electromagnetism.CapacitancePerArea'].componentShape()).toEqual([])
    expect(QuantityKind['acoustics.FlowResistivity'].componentShape()).toEqual([])
    expect(QuantityKind['mechanics.StiffnessPerArea'].componentShape()).toEqual([])
    expect(QuantityKind['thermodynamics.ThermalResistancePerArea'].componentShape()).toEqual([])
    expect(QuantityKind['coupledPhenomena.PyroelectricCoefficient'].componentShape()).toEqual([3])
    expect(QuantityKind['coupledPhenomena.MagnetoelectricCoefficient'].componentShape()).toEqual([3, 3])
    expect(QuantityKind['coupledPhenomena.PiezoelectricChargeCoefficient'].componentShape()).toEqual([3, 3, 3])
    expect(QuantityKind['coupledPhenomena.PiezoelectricVoltageCoefficient'].componentShape()).toEqual([3, 3, 3])
    expect(QuantityKind['coupledPhenomena.PiezoelectricStressCoefficient'].componentShape()).toEqual([3, 3, 3])
    expect(QuantityKind['coupledPhenomena.PiezoresistiveCoefficient'].componentShape()).toEqual([3, 3, 3, 3])
    expect(QuantityKind['coupledPhenomena.ElectrostrictionCoefficient'].componentShape()).toEqual([3, 3, 3, 3])
    expect(QuantityKind['mechanics.ElasticStiffnessTensor'].componentShape()).toEqual([3, 3, 3, 3])
    expect(QuantityKind['mechanics.ElasticComplianceTensor'].componentShape()).toEqual([3, 3, 3, 3])

    const expectedUnits = {
      'electromagnetism.CapacitancePerArea': [
        'F.m-2',
        'mF.m-2',
        'uF.cm-2',
        'uF.m-2',
        'nF.cm-2',
        'nF.m-2',
        'pF.cm-2',
        'pF.m-2',
      ],
      'acoustics.FlowResistivity': ['Pa.s.m-2', 'kPa.s.m-2', 'N.s.m-4', 'kN.s.m-4'],
      'mechanics.StiffnessPerArea': ['N.m-3', 'kN.m-3', 'MN.m-3', 'N.mm-3', 'kN.mm-3'],
      'thermodynamics.ThermalResistancePerArea': ['m2.K.W-1'],
      'coupledPhenomena.ElectricPotentialPerTemperature': ['V.K-1', 'mV.K-1', 'uV.K-1'],
      'coupledPhenomena.PiezoelectricChargeCoefficient': [
        'C.N-1',
        'mC.N-1',
        'uC.N-1',
        'nC.N-1',
        'pC.N-1',
        'm.V-1',
        'um.V-1',
        'nm.V-1',
        'pm.V-1',
      ],
      'coupledPhenomena.PiezoelectricVoltageCoefficient': [
        'V.m.N-1',
        'mV.m.N-1',
        'V.mm.N-1',
        'm2.C-1',
        'cm2.C-1',
        'mm2.C-1',
      ],
      'coupledPhenomena.PiezoelectricStressCoefficient': ['C.m-2', 'mC.m-2', 'uC.m-2', 'N.V-1.m-1', 'N.kV-1.mm-1'],
      'coupledPhenomena.PyroelectricCoefficient': ['C.m-2.K-1', 'mC.m-2.K-1', 'uC.m-2.K-1', 'nC.m-2.K-1'],
      'coupledPhenomena.PiezoresistiveCoefficient': ['Pa-1', 'kPa-1', 'MPa-1', 'GPa-1'],
      'coupledPhenomena.ElectrostrictionCoefficient': ['m2.V-2', 'cm2.kV-2', 'mm2.kV-2'],
      'coupledPhenomena.MagnetoelectricCoefficient': ['s.m-1', 'ms.m-1', 'us.m-1', 'ns.m-1', 'ps.m-1'],
    } as const
    for (const [name, units] of Object.entries(expectedUnits)) {
      expect(QuantityKind[name as keyof typeof expectedUnits].applicableUnits()).toEqual(units)
    }
    expect(QuantityKind['thermodynamics.ThermalResistancePerArea'].applicableUnits()).toEqual(
      QuantityKind['thermodynamics.ThermalInsulance'].applicableUnits(),
    )

    expectTypeOf(QuantityKind['coupledPhenomena.PiezoelectricChargeCoefficient'].componentShape()).toEqualTypeOf<
      readonly [3, 3, 3]
    >()
    expectTypeOf(QuantityKind['coupledPhenomena.PiezoresistiveCoefficient'].componentShape()).toEqualTypeOf<
      readonly [3, 3, 3, 3]
    >()
  })

  it('recursively converts high-rank components and preserves type inference and basis metadata', () => {
    const value = [
      [
        [1, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 2, 0],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 3],
      ],
    ] as const
    const transformed = QuantityKind['coupledPhenomena.PiezoelectricChargeCoefficient'].transform(
      value,
      'C.N-1',
      'pC.N-1',
    )
    expect(transformed[0][0][0]).toBeCloseTo(1e12)
    expect(transformed[1][1][1]).toBeCloseTo(2e12)
    expect(transformed[2][2][2]).toBeCloseTo(3e12)
    expect(Object.isFrozen(transformed[0][0])).toBe(true)
    expectTypeOf(transformed).toEqualTypeOf<
      QuantityKindComponentValue<'coupledPhenomena.PiezoelectricChargeCoefficient'>
    >()

    const metadata = normalizeQuantityMetadata(
      {
        unit: 'Pa-1',
        quantityKind: 'coupledPhenomena.PiezoresistiveCoefficient',
        basis: identityCartesianBasis,
      },
      'Piezoresistive coefficient',
    )
    expect(metadata.basis).toEqual(identityCartesianBasis)
    expect(Object.isFrozen(metadata.basis)).toBe(true)
  })

  it('builds arbitrary non-negative component orders without a scalar fallback', () => {
    expect(componentShapeForTensorOrder(3)).toEqual([3, 3, 3])
    expect(componentShapeForTensorOrder(4)).toEqual([3, 3, 3, 3])
    expect(Object.isFrozen(componentShapeForTensorOrder(4))).toBe(true)
    expect(() => componentShapeForTensorOrder(-1)).toThrow('non-negative safe integer')
    expect(() => componentShapeForTensorOrder(1.5)).toThrow('non-negative safe integer')
  })

  it('returns canonical descriptions with normalized whitespace and preserves missing values', () => {
    const descriptions = Object.values(QuantityKind).map((entry) => entry.description())

    expect(descriptions.filter((description) => description !== undefined)).toHaveLength(1_009)
    expect(descriptions.filter((description) => description === undefined)).toHaveLength(207)
    expect(QuantityKind['informationComputing.AbsoluteTypographicMeasurement'].description()).toBeUndefined()
    expect(QuantityKind['acoustics.AcousticImpedance'].description()).toContain('$\\textit{Acoustic Impedance}$')
    for (const description of descriptions) {
      if (description !== undefined) {
        expect(description).toBe(description.trim())
        expect(description).not.toMatch(/\s{2,}/)
      }
    }
  })

  it('returns frozen, unique, converter-compatible UCUM lists and explicit opaque exceptions', () => {
    const ucum = createUcumService()
    const entries = Object.values(QuantityKind)
    const withUnits = entries.filter((entry) => entry.applicableUnits().length > 0)
    const unitEntryCount = entries.reduce((sum, entry) => sum + entry.applicableUnits().length, 0)
    const opaqueNames = new Set<string>(opaqueQuantityKindNames)

    expect(withUnits).toHaveLength(1_216)
    expect(entries.length - withUnits.length).toBe(0)
    expect(unitEntryCount).toBe(10_338)
    expect(opaqueQuantityKindNames).toEqual([
      'LinearLogarithmicRatio',
      'thermodynamics.AreaTimeTemperature',
      'thermodynamics.LengthTemperatureTime',
      'thermodynamics.TemperatureVariance',
      'chemistry.Acidity',
      'chemistry.Basicity',
    ])
    expect(Object.isFrozen(opaqueQuantityKindNames)).toBe(true)
    expect(QuantityKind['fluidDynamics.APIGravity'].applicableUnits()).toEqual(['1'])
    expect(QuantityKind.Angle.applicableUnits()).not.toContain("'")
    expect(QuantityKind['thermodynamics.Temperature'].applicableUnits()).not.toContain('mCel')
    expect(QuantityKind['thermodynamics.ThermalResistancePerArea'].applicableUnits()).toEqual(['m2.K.W-1'])

    for (const entry of entries) {
      const units = entry.applicableUnits()
      expect(Object.isFrozen(units)).toBe(true)
      expect(new Set(units).size).toBe(units.length)
      for (const unit of units) {
        expect(() => ucum.validate(unit)).not.toThrow()
        expect(() => ucum.canonical(1, unit)).not.toThrow()
        if (!opaqueNames.has(entry.name)) expect(() => ucum.convert(1, units[0], unit)).not.toThrow()
      }
    }
  })

  it('allows opaque-unit identity use and rejects opaque cross-unit conversion', () => {
    expect(QuantityKind['chemistry.Acidity'].transform(7, '[pH]', '[pH]')).toBe(7)
    expect(QuantityKind.LinearLogarithmicRatio.transform(2, 'B.m-1', 'B.m-1')).toBe(2)
    expect(() => QuantityKind.LinearLogarithmicRatio.transform(2, 'B.m-1', 'dB.m-1')).toThrow(
      'does not support unit conversion',
    )
  })

  it('transforms linear and affine applicable units', () => {
    expect(QuantityKind.Length.transform(1_000, 'mm', 'm')).toBeCloseTo(1)
    expect(QuantityKind['thermodynamics.Temperature'].transform(0, 'Cel', 'K')).toBeCloseTo(273.15)
  })

  it('recursively converts vector and matrix components and rejects affine tensor conversions', () => {
    const vector = QuantityKind['electromagnetism.ElectricCurrentDensity'].transform([1, 2, 3], 'A.cm-2', 'A.m-2')
    const matrix = QuantityKind['electromagnetism.ElectricConductivity'].transform(
      [
        [1, 0, 0],
        [0, 2, 0],
        [0, 0, 3],
      ],
      'S.cm-1',
      'S.m-1',
    )

    expect(vector).toEqual([10_000, 20_000, 30_000])
    matrix.flat().forEach((component, index) => {
      expect(component).toBeCloseTo([100, 0, 0, 0, 200, 0, 0, 0, 300][index], 12)
    })
    expect(Object.isFrozen(vector)).toBe(true)
    expect(Object.isFrozen(matrix[0])).toBe(true)
    expect(() => transformQuantityComponents([0, 0, 0], [3], 'Cel', 'K', 'Synthetic vector conversion')).toThrow(
      'zero-preserving unit transform',
    )
  })

  it('rotates rank-1 through rank-4 Cartesian tensors while converting units and reverses exactly', () => {
    const rotatedBasis = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ] as const
    const axisTensor = (order: number): unknown =>
      order === 0
        ? 1
        : Object.freeze([
            axisTensor(order - 1),
            ...Array.from({ length: 2 }, () => (order === 1 ? 0 : zeroTensor(order - 1))),
          ])
    const zeroTensor = (order: number): unknown =>
      order === 0 ? 0 : Object.freeze(Array.from({ length: 3 }, () => zeroTensor(order - 1)))
    const cases = [
      { order: 1, from: 'N', to: 'kN', scale: -1e-3 },
      { order: 2, from: 'S.cm-1', to: 'S.m-1', scale: 100 },
      { order: 3, from: 'C.N-1', to: 'pC.N-1', scale: -1e12 },
      { order: 4, from: 'Pa', to: 'MPa', scale: 1e-6 },
    ] as const

    for (const { order, from, to, scale } of cases) {
      const source = axisTensor(order)
      const transformed = transformQuantityValue(
        source,
        componentShapeForTensorOrder(order),
        { unit: from, basis: identityCartesianBasis },
        { unit: to, basis: rotatedBasis },
      ) as readonly unknown[]
      let component: unknown = transformed
      for (let depth = 0; depth < order; depth += 1) {
        component = (component as readonly unknown[])[1]
      }
      expect(component).toBeCloseTo(scale)
      expect(
        transformQuantityValue(
          transformed,
          componentShapeForTensorOrder(order),
          { unit: to, basis: rotatedBasis },
          { unit: from, basis: identityCartesianBasis },
        ),
      ).toEqual(source)
      expect(Object.isFrozen(transformed)).toBe(true)
    }

    expect(transformQuantityValue(0, [], { unit: 'Cel' }, { unit: 'K' })).toBeCloseTo(273.15)
    expect(() => transformQuantityValue(1, [], { unit: '1', basis: identityCartesianBasis }, { unit: '1' })).toThrow(
      'basis is forbidden for a scalar quantity',
    )
  })

  it('rejects non-finite values, foreign units, and incompatible applicable units', () => {
    expect(() => QuantityKind.Length.transform(Number.NaN, 'mm', 'm')).toThrow(CadModelError)
    expect(() => QuantityKind.Length.transform(1, 's' as unknown as ApplicableUnit<'Length'>, 'm')).toThrow(
      'does not include source UCUM unit s',
    )
    expect(() => QuantityKind.Length.transform(1, 'm', 's' as unknown as ApplicableUnit<'Length'>)).toThrow(
      'does not include target UCUM unit s',
    )
    expect(() =>
      QuantityKind['kinematics.AngularAcceleration'].transform(
        [1, 1, 1],
        's-2' as unknown as ApplicableUnit<'kinematics.AngularAcceleration'>,
        'rad.s-2',
      ),
    ).toThrow('does not include source UCUM unit')
  })
})
