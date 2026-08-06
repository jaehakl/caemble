import { defineMaterialParameterDomain } from '../types'

export const coupledMaterialParameters = defineMaterialParameterDomain('coupled', [
  {
    key: 'coupled.piezoelectric_charge_coefficient',
    label_ko: '압전 전하계수',
    quantity_kind: 'coupledPhenomena.PiezoelectricChargeCoefficient',
    special_qualifiers: ['coordinate_frame', 'tensor_convention'],
  },
  {
    key: 'coupled.piezoelectric_voltage_coefficient',
    label_ko: '압전 전압계수',
    quantity_kind: 'coupledPhenomena.PiezoelectricVoltageCoefficient',
    special_qualifiers: ['coordinate_frame', 'tensor_convention'],
  },
  {
    key: 'coupled.piezoelectric_stress_coefficient',
    label_ko: '압전 응력계수',
    quantity_kind: 'coupledPhenomena.PiezoelectricStressCoefficient',
    special_qualifiers: ['coordinate_frame', 'tensor_convention'],
  },
  {
    key: 'coupled.pyroelectric_coefficient',
    label_ko: '초전계수',
    quantity_kind: 'coupledPhenomena.PyroelectricCoefficient',
    special_qualifiers: ['coordinate_frame'],
  },
  {
    key: 'coupled.piezoresistive_coefficient',
    label_ko: '압저항계수',
    quantity_kind: 'coupledPhenomena.PiezoresistiveCoefficient',
    special_qualifiers: ['coordinate_frame', 'tensor_convention'],
  },
  {
    key: 'coupled.magnetostriction',
    label_ko: '자왜율',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['magnetic_field', 'coordinate_frame'],
  },
  {
    key: 'coupled.electrostriction_coefficient',
    label_ko: '전왜계수',
    quantity_kind: 'coupledPhenomena.ElectrostrictionCoefficient',
    special_qualifiers: ['coordinate_frame', 'tensor_convention'],
  },
  {
    key: 'coupled.magnetoelectric_coefficient',
    label_ko: '자기전기 결합계수',
    quantity_kind: 'coupledPhenomena.MagnetoelectricCoefficient',
    special_qualifiers: ['coordinate_frame', 'frequency'],
  },
] as const)
