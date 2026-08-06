import { defineMaterialParameterDomain } from '../types'

export const radiativeMaterialParameters = defineMaterialParameterDomain('radiative', [
  {
    key: 'radiative.emissivity',
    label_ko: '방사율',
    quantity_kind: 'optics.Emissivity',
    special_qualifiers: ['wavelength_or_band', 'direction'],
  },
  {
    key: 'radiative.reflectivity',
    label_ko: '고유 반사율',
    quantity_kind: 'optics.Reflectivity',
    special_qualifiers: ['wavelength_or_frequency', 'incidence_angle', 'polarization'],
  },
] as const)
