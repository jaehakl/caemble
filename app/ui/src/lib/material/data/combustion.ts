import { defineMaterialParameterDomain } from '../types'

export const combustionMaterialParameters = defineMaterialParameterDomain('combustion', [
  {
    key: 'combustion.laminar_flame_speed',
    label_ko: '층류 화염속도',
    quantity_kind: 'kinematics.Speed',
    special_qualifiers: ['mixture', 'equivalence_ratio'],
  },
  {
    key: 'combustion.lower_flammability_limit',
    label_ko: '하한 가연한계',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['fuel', 'oxidizer', 'basis'],
  },
  {
    key: 'combustion.upper_flammability_limit',
    label_ko: '상한 가연한계',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['fuel', 'oxidizer', 'basis'],
  },
] as const)
