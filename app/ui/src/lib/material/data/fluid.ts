import { defineMaterialParameterDomain } from '../types'

export const fluidMaterialParameters = defineMaterialParameterDomain('fluid', [
  {
    key: 'fluid.dynamic_viscosity',
    label_ko: '동적 점도(점성계수)',
    quantity_kind: 'fluidDynamics.DynamicViscosity',
  },
  {
    key: 'fluid.kinematic_viscosity',
    label_ko: '동점도',
    quantity_kind: 'fluidDynamics.KinematicViscosity',
  },
  {
    key: 'fluid.bulk_viscosity',
    label_ko: '체적점도',
    quantity_kind: 'fluidDynamics.DynamicViscosity',
    special_qualifiers: ['definition'],
  },
  {
    key: 'fluid.fluidity',
    label_ko: '유동도',
    quantity_kind: 'fluidDynamics.Fluidity',
  },
  {
    key: 'fluid.isothermal_compressibility',
    label_ko: '등온 압축률',
    quantity_kind: 'fluidDynamics.IsothermalCompressibility',
  },
  {
    key: 'fluid.isentropic_compressibility',
    label_ko: '등엔트로피 압축률',
    quantity_kind: 'fluidDynamics.IsentropicCompressibility',
  },
  {
    key: 'fluid.speed_of_sound',
    label_ko: '음속',
    quantity_kind: 'acoustics.SpeedOfSound',
    special_qualifiers: ['wave_mode'],
  },
  {
    key: 'fluid.yield_stress',
    label_ko: '유변학적 항복응력',
    quantity_kind: 'mechanics.Stress',
    special_qualifiers: ['rheology_model'],
  },
] as const)
