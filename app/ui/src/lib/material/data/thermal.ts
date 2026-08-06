import { defineMaterialParameterDomain } from '../types'

export const thermalMaterialParameters = defineMaterialParameterDomain('thermal', [
  {
    key: 'thermal.conductivity',
    label_ko: '열전도율',
    quantity_kind: 'thermodynamics.ThermalConductivity',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'thermal.diffusivity',
    label_ko: '열확산도',
    quantity_kind: 'thermodynamics.ThermalDiffusivity',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'thermal.specific_heat_capacity',
    label_ko: '비열',
    quantity_kind: 'thermodynamics.SpecificHeatCapacity',
  },
  {
    key: 'thermal.specific_heat_capacity_cp',
    label_ko: '정압 비열',
    quantity_kind: 'thermodynamics.SpecificHeatCapacityAtConstantPressure',
  },
  {
    key: 'thermal.specific_heat_capacity_cv',
    label_ko: '정적 비열',
    quantity_kind: 'thermodynamics.SpecificHeatCapacityAtConstantVolume',
  },
  {
    key: 'thermal.volumetric_heat_capacity',
    label_ko: '체적 열용량',
    quantity_kind: 'thermodynamics.VolumetricHeatCapacity',
  },
  {
    key: 'thermal.heat_capacity_ratio',
    label_ko: '비열비',
    quantity_kind: 'thermodynamics.HeatCapacityRatio',
  },
  {
    key: 'thermal.linear_expansion_coefficient',
    label_ko: '선팽창계수',
    quantity_kind: 'thermodynamics.ThermalExpansionCoefficient',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'thermal.volumetric_expansion_coefficient',
    label_ko: '체적팽창계수',
    quantity_kind: 'thermodynamics.CubicExpansionCoefficient',
  },
  {
    key: 'thermal.resistivity',
    label_ko: '열저항률',
    quantity_kind: 'thermodynamics.ThermalResistivity',
  },
  {
    key: 'thermal.inertia',
    label_ko: '열관성',
    quantity_kind: 'thermodynamics.ThermalInertia',
  },
  {
    key: 'thermal.melting_temperature',
    label_ko: '융점',
    quantity_kind: 'thermodynamics.MeltingPoint',
  },
  {
    key: 'thermal.boiling_temperature',
    label_ko: '비점',
    quantity_kind: 'thermodynamics.BoilingPoint',
    special_qualifiers: ['ambient_pressure'],
  },
  {
    key: 'thermal.glass_transition_temperature',
    label_ko: '유리전이온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['measurement_method'],
  },
  {
    key: 'thermal.solidus_temperature',
    label_ko: '고상선 온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['composition'],
  },
  {
    key: 'thermal.liquidus_temperature',
    label_ko: '액상선 온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['composition'],
  },
  {
    key: 'thermal.decomposition_temperature',
    label_ko: '분해온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['environment', 'heating_rate'],
  },
  {
    key: 'thermal.latent_heat_fusion',
    label_ko: '융해 잠열',
    quantity_kind: 'SpecificEnergy',
  },
  {
    key: 'thermal.latent_heat_vaporization',
    label_ko: '기화 잠열',
    quantity_kind: 'SpecificEnergy',
    special_qualifiers: ['pressure'],
  },
  {
    key: 'thermal.thermal_insulance',
    label_ko: '열관류 저항',
    quantity_kind: 'thermodynamics.ThermalInsulance',
    special_qualifiers: ['thickness'],
  },
] as const)
