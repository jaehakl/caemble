import { defineMaterialParameterDomain } from '../types'

export const magneticMaterialParameters = defineMaterialParameterDomain('magnetic', [
  {
    key: 'magnetic.permeability',
    label_ko: '투자율',
    quantity_kind: 'electromagnetism.ElectromagneticPermeability',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'magnetic.relative_permeability',
    label_ko: '상대투자율',
    quantity_kind: 'electromagnetism.ElectromagneticPermeabilityRatio',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'magnetic.susceptibility',
    label_ko: '자기 감수율',
    quantity_kind: 'electromagnetism.MagneticSusceptability',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'magnetic.coercivity',
    label_ko: '보자력',
    quantity_kind: 'electromagnetism.Coercivity',
    special_qualifiers: ['hysteresis_branch', 'field_direction'],
  },
  {
    key: 'magnetic.remanent_flux_density',
    label_ko: '잔류 자속밀도',
    quantity_kind: 'electromagnetism.MagneticFluxDensity',
    special_qualifiers: ['field_direction'],
  },
  {
    key: 'magnetic.saturation_flux_density',
    label_ko: '포화 자속밀도',
    quantity_kind: 'electromagnetism.MagneticFluxDensity',
    special_qualifiers: ['field_direction'],
  },
  {
    key: 'magnetic.remanent_magnetization',
    label_ko: '잔류 자화',
    quantity_kind: 'electromagnetism.Magnetization',
    special_qualifiers: ['field_direction'],
  },
  {
    key: 'magnetic.saturation_magnetization',
    label_ko: '포화 자화',
    quantity_kind: 'electromagnetism.Magnetization',
    special_qualifiers: ['field_direction'],
  },
  {
    key: 'magnetic.curie_temperature',
    label_ko: '퀴리 온도',
    quantity_kind: 'materials.CurieTemperature',
  },
  {
    key: 'magnetic.neel_temperature',
    label_ko: '닐 온도',
    quantity_kind: 'materials.NeelTemperature',
  },
  {
    key: 'magnetic.lower_critical_flux_density',
    label_ko: '하부 임계 자속밀도',
    quantity_kind: 'materials.LowerCriticalMagneticFluxDensity',
  },
  {
    key: 'magnetic.upper_critical_flux_density',
    label_ko: '상부 임계 자속밀도',
    quantity_kind: 'materials.UpperCriticalMagneticFluxDensity',
  },
  {
    key: 'magnetic.superconducting_transition_temperature',
    label_ko: '초전도 전이온도',
    quantity_kind: 'materials.SuperconductionTransitionTemperature',
  },
  {
    key: 'magnetic.london_penetration_depth',
    label_ko: '런던 침투깊이',
    quantity_kind: 'materials.LondonPenetrationDepth',
  },
  {
    key: 'magnetic.coherence_length',
    label_ko: '결맞음 길이',
    quantity_kind: 'materials.CoherenceLength',
  },
  {
    key: 'magnetic.hysteresis_loss_density',
    label_ko: '자기 이력 손실 에너지밀도',
    quantity_kind: 'EnergyDensity',
    special_qualifiers: ['cycle', 'frequency'],
  },
] as const)
