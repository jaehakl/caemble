import { defineMaterialParameterDomain } from '../types'

export const electrochemicalMaterialParameters = defineMaterialParameterDomain('electrochemical', [
  {
    key: 'electrochemical.ionic_conductivity',
    label_ko: '이온전도도',
    quantity_kind: 'chemistry.ElectrolyticConductivity',
    special_qualifiers: ['mobile_ion', 'coordinate_frame'],
  },
  {
    key: 'electrochemical.molar_conductivity',
    label_ko: '몰 전도도',
    quantity_kind: 'chemistry.MolarConductivity',
    special_qualifiers: ['electrolyte'],
  },
  {
    key: 'electrochemical.ion_diffusion_coefficient',
    label_ko: '이온 확산계수',
    quantity_kind: 'transport.DiffusionCoefficient',
    special_qualifiers: ['ion', 'host_phase', 'coordinate_frame'],
  },
  {
    key: 'electrochemical.transport_number',
    label_ko: '이온 수송수',
    quantity_kind: 'chemistry.IonTransportNumber',
    special_qualifiers: ['ion'],
  },
  {
    key: 'electrochemical.open_circuit_potential',
    label_ko: '개방회로전위',
    quantity_kind: 'electromagnetism.ElectricPotential',
    special_qualifiers: ['electrode', 'reference_electrode', 'state_variable'],
  },
  {
    key: 'electrochemical.equilibrium_potential',
    label_ko: '평형전위',
    quantity_kind: 'electromagnetism.ElectricPotential',
    special_qualifiers: ['reaction', 'reference_electrode'],
  },
  {
    key: 'electrochemical.exchange_current_density',
    label_ko: '교환전류밀도',
    quantity_kind: 'electromagnetism.ElectricCurrentDensity',
    special_qualifiers: ['reaction', 'interface'],
  },
  {
    key: 'electrochemical.double_layer_capacitance_per_area',
    label_ko: '면적당 이중층 정전용량',
    quantity_kind: 'electromagnetism.CapacitancePerArea',
    special_qualifiers: ['interface'],
  },
  {
    key: 'electrochemical.specific_capacity',
    label_ko: '비용량',
    quantity_kind: 'electromagnetism.SpecificElectricCharge',
    special_qualifiers: ['active_material', 'charge_or_discharge'],
  },
  {
    key: 'electrochemical.volumetric_capacity',
    label_ko: '체적용량',
    quantity_kind: 'electromagnetism.ElectricChargeDensity',
    special_qualifiers: ['active_material', 'charge_or_discharge'],
  },
  {
    key: 'electrochemical.maximum_species_concentration',
    label_ko: '최대 종 농도',
    quantity_kind: 'chemistry.AmountOfSubstanceConcentration',
    special_qualifiers: ['species', 'host_phase'],
  },
  {
    key: 'electrochemical.charge_transfer_coefficient',
    label_ko: '전하이동계수',
    quantity_kind: 'Dimensionless',
    special_qualifiers: ['reaction', 'anodic_or_cathodic'],
  },
  {
    key: 'electrochemical.entropic_potential_coefficient',
    label_ko: '전위 엔트로피 계수',
    quantity_kind: 'coupledPhenomena.ElectricPotentialPerTemperature',
    special_qualifiers: ['electrode', 'state_variable'],
  },
  {
    key: 'electrochemical.active_specific_surface_area',
    label_ko: '활성 비표면적',
    quantity_kind: 'SpecificSurfaceArea',
    special_qualifiers: ['reaction_site'],
  },
] as const)
