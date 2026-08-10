import { describe, expect, it } from 'vitest'
import { quantityKindData } from '../quantitykind/data'
import { acousticMaterialParameters } from './data/acoustic'
import { chemicalMaterialParameters } from './data/chemical'
import { combustionMaterialParameters } from './data/combustion'
import { coupledMaterialParameters } from './data/coupled'
import { electricalMaterialParameters } from './data/electrical'
import { electrochemicalMaterialParameters } from './data/electrochemical'
import { fluidMaterialParameters } from './data/fluid'
import { generalMaterialParameters } from './data/general'
import { interfaceMaterialParameters } from './data/interface'
import { magneticMaterialParameters } from './data/magnetic'
import { mechanicalMaterialParameters } from './data/mechanical'
import { microstructureMaterialParameters } from './data/microstructure'
import { opticalMaterialParameters } from './data/optical'
import { radiationMaterialParameters } from './data/radiation'
import { radiativeMaterialParameters } from './data/radiative'
import { semiconductorMaterialParameters } from './data/semiconductor'
import { thermalMaterialParameters } from './data/thermal'
import { thermodynamicMaterialParameters } from './data/thermodynamic'
import { transportMaterialParameters } from './data/transport'
import {
  materialModelByKey,
  materialModelCatalog,
  materialModelData,
  materialParameterByKey,
  materialParameterCatalog,
  materialParameterData,
  materialParameterDomains,
} from './data'

const expectedDomainCounts = {
  general: 14,
  mechanical: 35,
  thermal: 20,
  thermodynamic: 16,
  fluid: 8,
  transport: 18,
  electrical: 15,
  magnetic: 16,
  optical: 13,
  radiative: 2,
  acoustic: 6,
  chemical: 13,
  combustion: 3,
  electrochemical: 14,
  semiconductor: 15,
  radiation: 16,
  microstructure: 11,
  coupled: 8,
  interface: 15,
} as const

const parametersByDomain = {
  general: generalMaterialParameters,
  mechanical: mechanicalMaterialParameters,
  thermal: thermalMaterialParameters,
  thermodynamic: thermodynamicMaterialParameters,
  fluid: fluidMaterialParameters,
  transport: transportMaterialParameters,
  electrical: electricalMaterialParameters,
  magnetic: magneticMaterialParameters,
  optical: opticalMaterialParameters,
  radiative: radiativeMaterialParameters,
  acoustic: acousticMaterialParameters,
  chemical: chemicalMaterialParameters,
  combustion: combustionMaterialParameters,
  electrochemical: electrochemicalMaterialParameters,
  semiconductor: semiconductorMaterialParameters,
  radiation: radiationMaterialParameters,
  microstructure: microstructureMaterialParameters,
  coupled: coupledMaterialParameters,
  interface: interfaceMaterialParameters,
} as const

type MaterialProperty = Readonly<{
  key: string
  label_ko: string
  quantity_kind: string
  special_qualifiers?: readonly string[]
}>

const properties = materialParameterData as readonly MaterialProperty[]

describe('material parameter catalog', () => {
  it('aggregates the frozen domain files with only the canonical property schema', () => {
    expect(materialParameterDomains).toEqual(Object.keys(expectedDomainCounts))
    expect(Object.isFrozen(materialParameterDomains)).toBe(true)
    expect(materialParameterData).toHaveLength(258)
    expect(new Set(properties.map(({ key }) => key)).size).toBe(258)
    expect(materialParameterCatalog.properties).toBe(materialParameterData)
    expect(Object.isFrozen(materialParameterData)).toBe(true)
    expect(Object.isFrozen(materialParameterCatalog)).toBe(true)
    expect(Object.isFrozen(materialParameterCatalog.design_rules)).toBe(true)
    expect(Object.isFrozen(materialParameterCatalog.global_qualifiers)).toBe(true)
    expect(materialParameterCatalog).not.toHaveProperty('model_namespace_examples')

    for (const [domain, expectedCount] of Object.entries(expectedDomainCounts)) {
      const domainParameters = parametersByDomain[domain as keyof typeof parametersByDomain]
      expect(domainParameters).toHaveLength(expectedCount)
      expect(Object.isFrozen(domainParameters)).toBe(true)
      expect(properties.filter(({ key }) => key.startsWith(`${domain}.`))).toEqual(domainParameters)
    }
    for (const property of properties) {
      const [domain, propertyName, ...extraSegments] = property.key.split('.')
      expect(materialParameterDomains).toContain(domain)
      expect(propertyName).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(extraSegments).toHaveLength(0)
      expect(Object.isFrozen(property)).toBe(true)
      expect(
        Object.keys(property).every((field) =>
          ['key', 'label_ko', 'quantity_kind', 'special_qualifiers'].includes(field),
        ),
      ).toBe(true)
      expect(property).not.toHaveProperty('tier')
      expect(property).not.toHaveProperty('scope')
      expect(property).not.toHaveProperty('value_form')
      if (property.special_qualifiers) {
        expect(Object.isFrozen(property.special_qualifiers)).toBe(true)
      }
    }
  })

  it('uses the canonical QuantityKind dataset without source prefixes or extensions', () => {
    expect(materialParameterCatalog.catalog_id).toBe('material-parameter-catalog')
    expect(materialParameterCatalog.catalog_version).toBe('0.0.0')
    expect(materialParameterCatalog.quantity_kind_data_version).toBe('0.0.1')
    expect(materialParameterCatalog.design_rules.quantity_kind).toEqual(expect.any(String))
    expect(materialParameterCatalog).not.toHaveProperty('aliases')
    expect(materialParameterCatalog).not.toHaveProperty('relationships')
    expect(materialParameterCatalog).not.toHaveProperty('quantity_kind_extensions')

    for (const property of properties) {
      expect(property.quantity_kind).not.toMatch(/^(?:mdb|qudt):/)
      expect(Object.prototype.hasOwnProperty.call(quantityKindData, property.quantity_kind)).toBe(true)
    }
  })

  it('keeps sampled dependencies in the enumerated model catalog only', () => {
    expect(materialParameterCatalog.design_rules).toHaveProperty('value_shape')
    expect(materialParameterCatalog.design_rules).not.toHaveProperty('value_representation')
    expect(materialParameterByKey).not.toHaveProperty('magnetic.b_h_curve')
    expect(materialParameterByKey).not.toHaveProperty('transport.sorption_isotherm')
    expect(materialModelCatalog).toMatchObject({
      catalog_id: 'material-model-catalog',
      catalog_version: '0.0.0',
      quantity_kind_data_version: '0.0.1',
    })
    expect(materialModelData).toHaveLength(2)
    expect(Object.keys(materialModelByKey)).toEqual(['model.magnetic_hysteresis.b_h_curve', 'model.sorption.isotherm'])
    expect(materialModelByKey['model.magnetic_hysteresis.b_h_curve']).toMatchObject({
      input: { quantity_kind: 'electromagnetism.MagneticFieldStrength' },
      output: { quantity_kind: 'electromagnetism.MagneticFluxDensity' },
      minimum_samples: 2,
      shared_basis: true,
    })
  })

  it('reuses the definition by meaning instead of the material-property domain', () => {
    const quantityKindFor = (key: string) => properties.find((property) => property.key === key)?.quantity_kind

    expect(quantityKindFor('interface.electrical_contact_resistance')).toBe('electromagnetism.Resistance')
    expect(quantityKindFor('transport.longitudinal_dispersivity')).toBe('Length')
    expect(quantityKindFor('mechanical.lame_first_parameter')).toBe('mechanics.Stress')
    expect(quantityKindFor('mechanical.yield_strength')).toBe('mechanics.Stress')
    expect(quantityKindFor('mechanical.tensile_strength')).toBe('mechanics.Stress')
    expect(quantityKindFor('mechanical.compressive_strength')).toBe('mechanics.Stress')
    expect(quantityKindFor('fluid.yield_stress')).toBe('mechanics.Stress')
    expect(quantityKindFor('interface.cohesive_strength')).toBe('mechanics.Stress')
    expect(quantityKindFor('electrochemical.double_layer_capacitance_per_area')).toBe(
      'electromagnetism.CapacitancePerArea',
    )
    expect(quantityKindFor('mechanical.loss_factor')).toBe('LossFactor')
    expect(quantityKindFor('electrical.loss_tangent')).toBe('LossFactor')
    expect(quantityKindFor('optical.absorptance')).toBe('Absorptance')
    expect(quantityKindFor('acoustic.absorption_coefficient')).toBe('Absorptance')
  })
})
