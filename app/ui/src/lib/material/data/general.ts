import { defineMaterialParameterDomain } from '../types'

export const generalMaterialParameters = defineMaterialParameterDomain('general', [
  {
    key: 'general.mass_density',
    label_ko: '질량 밀도',
    quantity_kind: 'MassDensity',
  },
  {
    key: 'general.specific_volume',
    label_ko: '비체적',
    quantity_kind: 'SpecificVolume',
  },
  {
    key: 'general.molar_mass',
    label_ko: '몰 질량',
    quantity_kind: 'chemistry.MolarMass',
    special_qualifiers: ['species_or_mixture'],
  },
  {
    key: 'general.porosity',
    label_ko: '공극률',
    quantity_kind: 'DimensionlessRatio',
  },
  {
    key: 'general.mass_fraction',
    label_ko: '질량분율',
    quantity_kind: 'MassFraction',
    special_qualifiers: ['constituent'],
  },
  {
    key: 'general.mole_fraction',
    label_ko: '몰분율',
    quantity_kind: 'chemistry.MoleFraction',
    special_qualifiers: ['constituent'],
  },
  {
    key: 'general.volume_fraction',
    label_ko: '체적분율',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['constituent_or_phase'],
  },
  {
    key: 'general.number_density',
    label_ko: '수 밀도',
    quantity_kind: 'NumberDensity',
    special_qualifiers: ['entity'],
  },
  {
    key: 'general.molar_concentration',
    label_ko: '몰 농도',
    quantity_kind: 'chemistry.AmountOfSubstanceConcentration',
    special_qualifiers: ['species'],
  },
  {
    key: 'general.mass_concentration',
    label_ko: '질량 농도',
    quantity_kind: 'chemistry.MassConcentration',
    special_qualifiers: ['species'],
  },
  {
    key: 'general.specific_surface_area',
    label_ko: '비표면적',
    quantity_kind: 'SpecificSurfaceArea',
  },
  {
    key: 'general.moisture_mass_fraction',
    label_ko: '수분 질량분율',
    quantity_kind: 'MassFractionOfWater',
    special_qualifiers: ['moisture_definition'],
  },
  {
    key: 'general.water_to_dry_mass_ratio',
    label_ko: '건조질량 기준 함수비',
    quantity_kind: 'MassRatioOfWaterToDryMatter',
    special_qualifiers: ['moisture_definition'],
  },
  {
    key: 'general.packing_fraction',
    label_ko: '충진율',
    quantity_kind: 'materials.PackingFraction',
  },
] as const)
