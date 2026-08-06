import { defineMaterialParameterDomain } from '../types'

export const transportMaterialParameters = defineMaterialParameterDomain('transport', [
  {
    key: 'transport.diffusion_coefficient',
    label_ko: '확산계수',
    quantity_kind: 'transport.DiffusionCoefficient',
    special_qualifiers: ['species', 'phase', 'coordinate_frame'],
  },
  {
    key: 'transport.binary_diffusion_coefficient',
    label_ko: '이성분 확산계수',
    quantity_kind: 'transport.DiffusionCoefficient',
    special_qualifiers: ['species_pair', 'phase'],
  },
  {
    key: 'transport.moisture_diffusivity',
    label_ko: '수분 확산도',
    quantity_kind: 'transport.DiffusionCoefficient',
    special_qualifiers: ['moisture_definition'],
  },
  {
    key: 'transport.water_vapor_diffusion_coefficient',
    label_ko: '수증기 확산계수',
    quantity_kind: 'transport.WaterVapourDiffusionCoefficient',
    special_qualifiers: ['gas_mixture'],
  },
  {
    key: 'transport.thermal_diffusion_factor',
    label_ko: '열확산 인자',
    quantity_kind: 'transport.ThermalDiffusionFactor',
    special_qualifiers: ['species_pair'],
  },
  {
    key: 'transport.intrinsic_permeability',
    label_ko: '고유투수율',
    quantity_kind: 'transport.HydraulicPermeability',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'transport.relative_permeability',
    label_ko: '상대투수율',
    quantity_kind: 'transport.PermeabilityRatio',
    special_qualifiers: ['phase', 'saturation_definition'],
  },
  {
    key: 'transport.vapor_permeability',
    label_ko: '수증기 투과율',
    quantity_kind: 'transport.VapourPermeability',
    special_qualifiers: ['species', 'driving_force_definition'],
  },
  {
    key: 'transport.vapor_permeance',
    label_ko: '수증기 투과도',
    quantity_kind: 'transport.VapourPermeance',
    special_qualifiers: ['thickness'],
  },
  {
    key: 'transport.tortuosity',
    label_ko: '굴곡도',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['transport_mode', 'coordinate_frame'],
  },
  {
    key: 'transport.longitudinal_dispersivity',
    label_ko: '종방향 분산도',
    quantity_kind: 'Length',
    special_qualifiers: ['flow_direction'],
  },
  {
    key: 'transport.transverse_dispersivity',
    label_ko: '횡방향 분산도',
    quantity_kind: 'Length',
    special_qualifiers: ['flow_direction'],
  },
  {
    key: 'transport.solubility',
    label_ko: '용해도',
    quantity_kind: 'chemistry.AmountOfSubstanceConcentration',
    special_qualifiers: ['solute', 'solvent'],
  },
  {
    key: 'transport.henry_constant',
    label_ko: '헨리 상수',
    quantity_kind: 'chemistry.HenrysLawVolatilityConstant',
    special_qualifiers: ['solute', 'solvent', 'definition'],
  },
  {
    key: 'transport.partition_coefficient',
    label_ko: '분배계수',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['species', 'phase_pair', 'definition'],
  },
  {
    key: 'transport.adsorption_coefficient',
    label_ko: '흡착계수',
    quantity_kind: 'chemistry.SoilAdsorptionCoefficient',
    special_qualifiers: ['species', 'sorbent', 'definition'],
  },
  {
    key: 'transport.capillary_pressure',
    label_ko: '모세관압',
    quantity_kind: 'Pressure',
    special_qualifiers: ['phase_pair', 'saturation_definition'],
  },
  {
    key: 'transport.mobility',
    label_ko: '이동도',
    quantity_kind: 'transport.Mobility',
    special_qualifiers: ['carrier_or_species', 'driving_field'],
  },
] as const)
