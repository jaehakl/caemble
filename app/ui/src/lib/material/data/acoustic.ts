import { defineMaterialParameterDomain } from '../types'

export const acousticMaterialParameters = defineMaterialParameterDomain('acoustic', [
  {
    key: 'acoustic.characteristic_impedance',
    label_ko: '특성 음향 임피던스',
    quantity_kind: 'acoustics.CharacteristicAcousticImpedance',
    special_qualifiers: ['frequency', 'propagation_direction'],
  },
  {
    key: 'acoustic.impedance',
    label_ko: '음향 임피던스',
    quantity_kind: 'acoustics.AcousticImpedance',
    special_qualifiers: ['frequency', 'boundary_definition'],
  },
  {
    key: 'acoustic.attenuation_coefficient',
    label_ko: '음향 감쇠계수',
    quantity_kind: 'AttenuationCoefficient',
    special_qualifiers: ['frequency', 'wave_mode'],
  },
  {
    key: 'acoustic.absorption_coefficient',
    label_ko: '흡음률',
    quantity_kind: 'Absorptance',
    special_qualifiers: ['frequency', 'incidence_angle'],
  },
  {
    key: 'acoustic.loss_factor',
    label_ko: '음향 손실계수',
    quantity_kind: 'LossFactor',
    special_qualifiers: ['frequency', 'wave_mode'],
  },
  {
    key: 'acoustic.flow_resistivity',
    label_ko: '유동저항률',
    quantity_kind: 'acoustics.FlowResistivity',
    special_qualifiers: ['flow_direction'],
  },
] as const)
