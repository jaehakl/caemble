import { defineMaterialParameterDomain } from '../types'

export const chemicalMaterialParameters = defineMaterialParameterDomain('chemical', [
  {
    key: 'chemical.ph',
    label_ko: 'pH',
    quantity_kind: 'chemistry.Acidity',
    special_qualifiers: ['solvent', 'measurement_scale'],
  },
  {
    key: 'chemical.ionic_strength',
    label_ko: '이온강도',
    quantity_kind: 'chemistry.IonicStrength',
    special_qualifiers: ['solution'],
  },
  {
    key: 'chemical.first_order_rate_constant',
    label_ko: '1차 반응속도상수',
    quantity_kind: 'InverseTime',
    special_qualifiers: ['reaction'],
  },
  {
    key: 'chemical.second_order_rate_constant',
    label_ko: '2차 반응속도상수',
    quantity_kind: 'chemistry.SecondOrderReactionRateConstant',
    special_qualifiers: ['reaction'],
  },
  {
    key: 'chemical.activation_energy',
    label_ko: '활성화에너지',
    quantity_kind: 'chemistry.MolarEnergy',
    special_qualifiers: ['reaction'],
  },
  {
    key: 'chemical.heat_of_reaction',
    label_ko: '반응열',
    quantity_kind: 'chemistry.MolarEnergy',
    special_qualifiers: ['reaction', 'reference_state'],
  },
  {
    key: 'chemical.standard_enthalpy_of_formation',
    label_ko: '표준 생성 엔탈피',
    quantity_kind: 'chemistry.MolarEnergy',
    special_qualifiers: ['species', 'reference_state'],
  },
  {
    key: 'chemical.standard_gibbs_energy_of_formation',
    label_ko: '표준 생성 깁스에너지',
    quantity_kind: 'chemistry.MolarEnergy',
    special_qualifiers: ['species', 'reference_state'],
  },
  {
    key: 'chemical.standard_molar_entropy',
    label_ko: '표준 몰 엔트로피',
    quantity_kind: 'chemistry.MolarEntropy',
    special_qualifiers: ['species', 'reference_state'],
  },
  {
    key: 'chemical.heating_value',
    label_ko: '발열량',
    quantity_kind: 'thermodynamics.HeatingValue',
    special_qualifiers: ['higher_or_lower', 'reference_state'],
  },
  {
    key: 'chemical.flash_point',
    label_ko: '인화점',
    quantity_kind: 'chemistry.FlashPoint',
    special_qualifiers: ['test_method'],
  },
  {
    key: 'chemical.autoignition_temperature',
    label_ko: '자연발화온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['test_method', 'environment'],
  },
  {
    key: 'chemical.catalytic_activity',
    label_ko: '촉매 활성',
    quantity_kind: 'chemistry.CatalyticActivity',
    special_qualifiers: ['reaction', 'catalyst_state'],
  },
] as const)
