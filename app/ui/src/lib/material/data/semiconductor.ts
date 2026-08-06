import { defineMaterialParameterDomain } from '../types'

export const semiconductorMaterialParameters = defineMaterialParameterDomain('semiconductor', [
  {
    key: 'semiconductor.band_gap_energy',
    label_ko: '밴드갭 에너지',
    quantity_kind: 'materials.GapEnergy',
    special_qualifiers: ['band_transition'],
  },
  {
    key: 'semiconductor.electron_affinity',
    label_ko: '전자친화도',
    quantity_kind: 'materials.ElectronAffinity',
    special_qualifiers: ['surface_orientation'],
  },
  {
    key: 'semiconductor.electron_mobility',
    label_ko: '전자 이동도',
    quantity_kind: 'materials.ElectronMobility',
    special_qualifiers: ['field_regime', 'coordinate_frame'],
  },
  {
    key: 'semiconductor.hole_mobility',
    label_ko: '정공 이동도',
    quantity_kind: 'transport.Mobility',
    special_qualifiers: ['field_regime', 'coordinate_frame'],
  },
  {
    key: 'semiconductor.electron_density',
    label_ko: '전자 밀도',
    quantity_kind: 'materials.ElectronDensity',
  },
  {
    key: 'semiconductor.hole_density',
    label_ko: '정공 밀도',
    quantity_kind: 'materials.HoleDensity',
  },
  {
    key: 'semiconductor.intrinsic_carrier_density',
    label_ko: '고유 캐리어 밀도',
    quantity_kind: 'materials.IntrinsicCarrierDensity',
  },
  {
    key: 'semiconductor.donor_density',
    label_ko: '도너 농도',
    quantity_kind: 'materials.DonorDensity',
    special_qualifiers: ['dopant'],
  },
  {
    key: 'semiconductor.acceptor_density',
    label_ko: '억셉터 농도',
    quantity_kind: 'materials.AcceptorDensity',
    special_qualifiers: ['dopant'],
  },
  {
    key: 'semiconductor.carrier_lifetime',
    label_ko: '캐리어 수명',
    quantity_kind: 'materials.CarrierLifetime',
    special_qualifiers: ['carrier_type', 'recombination_mechanism'],
  },
  {
    key: 'semiconductor.recombination_coefficient',
    label_ko: '재결합계수',
    quantity_kind: 'materials.RecombinationCoefficient',
    special_qualifiers: ['recombination_mechanism'],
  },
  {
    key: 'semiconductor.electron_effective_mass',
    label_ko: '전자 유효질량',
    quantity_kind: 'materials.EffectiveMass',
    special_qualifiers: ['band', 'coordinate_frame'],
  },
  {
    key: 'semiconductor.hole_effective_mass',
    label_ko: '정공 유효질량',
    quantity_kind: 'materials.EffectiveMass',
    special_qualifiers: ['band', 'coordinate_frame'],
  },
  {
    key: 'semiconductor.saturation_velocity',
    label_ko: '캐리어 포화속도',
    quantity_kind: 'kinematics.Speed',
    special_qualifiers: ['carrier_type', 'field_direction'],
  },
  {
    key: 'semiconductor.impact_ionization_coefficient',
    label_ko: '충돌 이온화계수',
    quantity_kind: 'InverseLength',
    special_qualifiers: ['carrier_type', 'field_direction'],
  },
] as const)
