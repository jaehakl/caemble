import { defineMaterialParameterDomain } from '../types'

export const electricalMaterialParameters = defineMaterialParameterDomain('electrical', [
  {
    key: 'electrical.conductivity',
    label_ko: '전기전도도',
    quantity_kind: 'electromagnetism.ElectricConductivity',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'electrical.resistivity',
    label_ko: '비저항',
    quantity_kind: 'electromagnetism.Resistivity',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'electrical.permittivity',
    label_ko: '유전율',
    quantity_kind: 'electromagnetism.Permittivity',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'electrical.relative_permittivity',
    label_ko: '상대유전율',
    quantity_kind: 'electromagnetism.RelativePermittivity',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'electrical.susceptibility',
    label_ko: '전기 감수율',
    quantity_kind: 'electromagnetism.ElectricSusceptibility',
    special_qualifiers: ['frequency', 'coordinate_frame'],
  },
  {
    key: 'electrical.dielectric_strength',
    label_ko: '절연 파괴 전계강도',
    quantity_kind: 'electromagnetism.ElectricFieldStrength',
    special_qualifiers: ['test_method', 'waveform', 'thickness'],
  },
  {
    key: 'electrical.loss_tangent',
    label_ko: '유전 손실탄젠트',
    quantity_kind: 'LossFactor',
    special_qualifiers: ['frequency', 'field_direction'],
  },
  {
    key: 'electrical.loss_angle',
    label_ko: '유전 손실각',
    quantity_kind: 'electromagnetism.LossAngle',
    special_qualifiers: ['frequency', 'field_direction'],
  },
  {
    key: 'electrical.polarization',
    label_ko: '전기 분극',
    quantity_kind: 'electromagnetism.ElectricPolarization',
    special_qualifiers: ['electric_field', 'coordinate_frame'],
  },
  {
    key: 'electrical.work_function',
    label_ko: '일함수',
    quantity_kind: 'materials.WorkFunction',
    special_qualifiers: ['surface_orientation'],
  },
  {
    key: 'electrical.hall_coefficient',
    label_ko: '홀 계수',
    quantity_kind: 'electromagnetism.HallCoefficient',
    special_qualifiers: ['carrier_type', 'field_direction'],
  },
  {
    key: 'electrical.seebeck_coefficient',
    label_ko: '제벡 계수',
    quantity_kind: 'coupledPhenomena.SeebeckCoefficient',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'electrical.peltier_coefficient',
    label_ko: '펠티에 계수',
    quantity_kind: 'coupledPhenomena.PeltierCoefficient',
    special_qualifiers: ['junction_pair', 'coordinate_frame'],
  },
  {
    key: 'electrical.surface_resistance',
    label_ko: '표면저항',
    quantity_kind: 'electromagnetism.Resistance',
    special_qualifiers: ['electrode_geometry'],
  },
  {
    key: 'electrical.dielectric_relaxation_time',
    label_ko: '유전 완화시간',
    quantity_kind: 'RelaxationTime',
    special_qualifiers: ['mode_or_branch_index'],
  },
] as const)
