import { defineMaterialParameterDomain } from '../types'

export const opticalMaterialParameters = defineMaterialParameterDomain('optical', [
  {
    key: 'optical.refractive_index',
    label_ko: '굴절률',
    quantity_kind: 'optics.RefractiveIndex',
    special_qualifiers: ['wavelength_or_frequency', 'polarization', 'coordinate_frame'],
  },
  {
    key: 'optical.extinction_coefficient',
    label_ko: '소광계수',
    quantity_kind: 'Dimensionless',
    special_qualifiers: ['wavelength_or_frequency', 'polarization'],
  },
  {
    key: 'optical.absorption_coefficient',
    label_ko: '광 흡수계수',
    quantity_kind: 'optics.LinearAbsorptionCoefficient',
    special_qualifiers: ['wavelength_or_frequency', 'polarization'],
  },
  {
    key: 'optical.attenuation_coefficient',
    label_ko: '광 감쇠계수',
    quantity_kind: 'AttenuationCoefficient',
    special_qualifiers: ['wavelength_or_frequency', 'polarization'],
  },
  {
    key: 'optical.scattering_coefficient',
    label_ko: '광 산란계수',
    quantity_kind: 'InverseLength',
    special_qualifiers: ['wavelength_or_frequency', 'scattering_definition'],
  },
  {
    key: 'optical.molar_absorption_coefficient',
    label_ko: '몰 흡광계수',
    quantity_kind: 'optics.MolarAbsorptionCoefficient',
    special_qualifiers: ['species', 'wavelength_or_frequency'],
  },
  {
    key: 'optical.reflectance',
    label_ko: '반사율',
    quantity_kind: 'optics.Reflectance',
    special_qualifiers: ['wavelength_or_frequency', 'incidence_angle', 'polarization'],
  },
  {
    key: 'optical.transmittance',
    label_ko: '투과율',
    quantity_kind: 'optics.Transmittance',
    special_qualifiers: ['wavelength_or_frequency', 'thickness', 'incidence_angle', 'polarization'],
  },
  {
    key: 'optical.absorptance',
    label_ko: '흡수율',
    quantity_kind: 'Absorptance',
    special_qualifiers: ['wavelength_or_frequency', 'incidence_angle', 'polarization'],
  },
  {
    key: 'optical.abbe_number',
    label_ko: '아베수',
    quantity_kind: 'optics.Constringence',
    special_qualifiers: ['spectral_definition'],
  },
  {
    key: 'optical.phase_coefficient',
    label_ko: '위상계수',
    quantity_kind: 'optics.PhaseCoefficient',
    special_qualifiers: ['frequency', 'propagation_direction'],
  },
  {
    key: 'optical.specific_rotatory_power',
    label_ko: '비선광도',
    quantity_kind: 'optics.SpecificOpticalRotatoryPower',
    special_qualifiers: ['wavelength', 'path_direction'],
  },
  {
    key: 'optical.nonlinear_refractive_index',
    label_ko: '비선형 굴절률',
    quantity_kind: 'optics.AreaPerPower',
    special_qualifiers: ['wavelength_or_frequency', 'polarization'],
  },
] as const)
