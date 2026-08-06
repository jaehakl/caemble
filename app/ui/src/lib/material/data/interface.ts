import { defineMaterialParameterDomain } from '../types'

export const interfaceMaterialParameters = defineMaterialParameterDomain('interface', [
  {
    key: 'interface.static_friction_coefficient',
    label_ko: '정지마찰계수',
    quantity_kind: 'mechanics.StaticFrictionCoefficient',
    special_qualifiers: ['material_pair', 'surface_state'],
  },
  {
    key: 'interface.dynamic_friction_coefficient',
    label_ko: '동마찰계수',
    quantity_kind: 'mechanics.DynamicFrictionCoefficient',
    special_qualifiers: ['material_pair', 'surface_state', 'slip_rate'],
  },
  {
    key: 'interface.contact_angle',
    label_ko: '접촉각',
    quantity_kind: 'PlaneAngle',
    special_qualifiers: ['solid', 'liquid', 'gas', 'advancing_or_receding'],
  },
  {
    key: 'interface.interfacial_tension',
    label_ko: '계면장력',
    quantity_kind: 'fluidDynamics.SurfaceTension',
    special_qualifiers: ['phase_pair'],
  },
  {
    key: 'interface.interfacial_energy',
    label_ko: '계면에너지',
    quantity_kind: 'EnergyPerArea',
    special_qualifiers: ['material_or_phase_pair', 'interface_orientation'],
  },
  {
    key: 'interface.adhesion_energy',
    label_ko: '접착에너지',
    quantity_kind: 'EnergyPerArea',
    special_qualifiers: ['material_pair', 'surface_state'],
  },
  {
    key: 'interface.cohesive_strength',
    label_ko: '계면 응집강도',
    quantity_kind: 'mechanics.Stress',
    special_qualifiers: ['material_pair', 'loading_mode'],
  },
  {
    key: 'interface.normal_stiffness_per_area',
    label_ko: '면적당 법선 접촉강성',
    quantity_kind: 'mechanics.StiffnessPerArea',
    special_qualifiers: ['material_pair'],
  },
  {
    key: 'interface.tangential_stiffness_per_area',
    label_ko: '면적당 접선 접촉강성',
    quantity_kind: 'mechanics.StiffnessPerArea',
    special_qualifiers: ['material_pair', 'shear_direction'],
  },
  {
    key: 'interface.critical_normal_separation',
    label_ko: '임계 법선 분리거리',
    quantity_kind: 'Length',
    special_qualifiers: ['material_pair'],
  },
  {
    key: 'interface.critical_tangential_separation',
    label_ko: '임계 접선 분리거리',
    quantity_kind: 'Length',
    special_qualifiers: ['material_pair', 'shear_direction'],
  },
  {
    key: 'interface.thermal_contact_conductance',
    label_ko: '열접촉 컨덕턴스',
    quantity_kind: 'thermodynamics.CoefficientOfHeatTransfer',
    special_qualifiers: ['material_pair', 'contact_pressure', 'surface_state'],
  },
  {
    key: 'interface.thermal_contact_resistance_per_area',
    label_ko: '면적 열접촉저항',
    quantity_kind: 'thermodynamics.ThermalResistancePerArea',
    special_qualifiers: ['material_pair', 'contact_pressure', 'surface_state'],
  },
  {
    key: 'interface.electrical_contact_resistance',
    label_ko: '전기 접촉저항',
    quantity_kind: 'electromagnetism.Resistance',
    special_qualifiers: ['material_pair', 'contact_pressure', 'surface_state'],
  },
  {
    key: 'interface.mass_transfer_coefficient',
    label_ko: '계면 물질전달계수',
    quantity_kind: 'kinematics.Speed',
    special_qualifiers: ['species', 'phase_pair'],
  },
] as const)
