import { defineMaterialParameterDomain } from '../types'

export const radiationMaterialParameters = defineMaterialParameterDomain('radiation', [
  {
    key: 'radiation.linear_attenuation_coefficient',
    label_ko: '선형 감쇠계수',
    quantity_kind: 'atomicNuclear.LinearAttenuationCoefficient',
    special_qualifiers: ['particle_or_photon', 'energy'],
  },
  {
    key: 'radiation.mass_attenuation_coefficient',
    label_ko: '질량 감쇠계수',
    quantity_kind: 'atomicNuclear.MassAttenuationCoefficient',
    special_qualifiers: ['particle_or_photon', 'energy'],
  },
  {
    key: 'radiation.mass_absorption_coefficient',
    label_ko: '질량 흡수계수',
    quantity_kind: 'atomicNuclear.MassAbsorptionCoefficient',
    special_qualifiers: ['particle_or_photon', 'energy'],
  },
  {
    key: 'radiation.molar_attenuation_coefficient',
    label_ko: '몰 감쇠계수',
    quantity_kind: 'atomicNuclear.MolarAttenuationCoefficient',
    special_qualifiers: ['particle_or_photon', 'energy'],
  },
  {
    key: 'radiation.microscopic_cross_section',
    label_ko: '미시적 단면적',
    quantity_kind: 'atomicNuclear.CrossSection',
    special_qualifiers: ['incident_particle', 'target_nuclide', 'reaction', 'energy'],
  },
  {
    key: 'radiation.macroscopic_cross_section',
    label_ko: '거시적 단면적',
    quantity_kind: 'atomicNuclear.MacroscopicCrossSection',
    special_qualifiers: ['incident_particle', 'reaction', 'energy'],
  },
  {
    key: 'radiation.total_cross_section',
    label_ko: '총 단면적',
    quantity_kind: 'atomicNuclear.TotalCrossSection',
    special_qualifiers: ['incident_particle', 'target_nuclide', 'energy'],
  },
  {
    key: 'radiation.linear_stopping_power',
    label_ko: '선형 저지능',
    quantity_kind: 'atomicNuclear.TotalLinearStoppingPower',
    special_qualifiers: ['particle', 'energy'],
  },
  {
    key: 'radiation.mass_stopping_power',
    label_ko: '질량 저지능',
    quantity_kind: 'atomicNuclear.TotalMassStoppingPower',
    special_qualifiers: ['particle', 'energy'],
  },
  {
    key: 'radiation.half_life',
    label_ko: '반감기',
    quantity_kind: 'atomicNuclear.HalfLife',
    special_qualifiers: ['nuclide', 'decay_mode'],
  },
  {
    key: 'radiation.decay_constant',
    label_ko: '붕괴상수',
    quantity_kind: 'atomicNuclear.DecayConstant',
    special_qualifiers: ['nuclide', 'decay_mode'],
  },
  {
    key: 'radiation.specific_activity',
    label_ko: '비방사능',
    quantity_kind: 'atomicNuclear.SpecificActivity',
    special_qualifiers: ['nuclide', 'reference_time'],
  },
  {
    key: 'radiation.neutron_diffusion_coefficient',
    label_ko: '중성자 확산계수',
    quantity_kind: 'atomicNuclear.NeutronDiffusionCoefficient',
    special_qualifiers: ['energy_group'],
  },
  {
    key: 'radiation.neutron_diffusion_length',
    label_ko: '중성자 확산길이',
    quantity_kind: 'atomicNuclear.NeutronDiffusionLength',
    special_qualifiers: ['energy_group'],
  },
  {
    key: 'radiation.mean_free_path',
    label_ko: '평균 자유행로',
    quantity_kind: 'transport.MeanFreePath',
    special_qualifiers: ['particle_or_photon', 'energy'],
  },
  {
    key: 'radiation.mass_energy_transfer_coefficient',
    label_ko: '질량 에너지 전달계수',
    quantity_kind: 'atomicNuclear.MassEnergyTransferCoefficient',
    special_qualifiers: ['photon_energy'],
  },
] as const)
