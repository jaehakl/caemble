import { defineMaterialParameterDomain } from '../types'

export const thermodynamicMaterialParameters = defineMaterialParameterDomain('thermodynamic', [
  {
    key: 'thermodynamic.vapor_pressure',
    label_ko: '증기압',
    quantity_kind: 'thermodynamics.VapourPressure',
    special_qualifiers: ['species_or_mixture'],
  },
  {
    key: 'thermodynamic.compressibility_factor',
    label_ko: '압축성 계수',
    quantity_kind: 'thermodynamics.CompressibilityFactor',
    special_qualifiers: ['mixture'],
  },
  {
    key: 'thermodynamic.critical_temperature',
    label_ko: '임계온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['species_or_mixture'],
  },
  {
    key: 'thermodynamic.critical_pressure',
    label_ko: '임계압력',
    quantity_kind: 'Pressure',
    special_qualifiers: ['species_or_mixture'],
  },
  {
    key: 'thermodynamic.triple_point_temperature',
    label_ko: '삼중점 온도',
    quantity_kind: 'thermodynamics.ThermodynamicTemperature',
    special_qualifiers: ['species'],
  },
  {
    key: 'thermodynamic.specific_enthalpy',
    label_ko: '비엔탈피',
    quantity_kind: 'thermodynamics.SpecificEnthalpy',
  },
  {
    key: 'thermodynamic.specific_internal_energy',
    label_ko: '비내부에너지',
    quantity_kind: 'thermodynamics.SpecificInternalEnergy',
  },
  {
    key: 'thermodynamic.specific_entropy',
    label_ko: '비엔트로피',
    quantity_kind: 'thermodynamics.SpecificEntropy',
  },
  {
    key: 'thermodynamic.specific_gibbs_energy',
    label_ko: '비깁스에너지',
    quantity_kind: 'thermodynamics.SpecificGibbsEnergy',
  },
  {
    key: 'thermodynamic.specific_helmholtz_energy',
    label_ko: '비헬름홀츠에너지',
    quantity_kind: 'thermodynamics.SpecificHelmholtzEnergy',
  },
  {
    key: 'thermodynamic.chemical_potential',
    label_ko: '화학 퍼텐셜',
    quantity_kind: 'chemistry.ChemicalPotential',
    special_qualifiers: ['species'],
  },
  {
    key: 'thermodynamic.activity_coefficient',
    label_ko: '활동도 계수',
    quantity_kind: 'chemistry.ActivityCoefficient',
    special_qualifiers: ['species', 'mixture_composition'],
  },
  {
    key: 'thermodynamic.fugacity',
    label_ko: '퓨가시티',
    quantity_kind: 'chemistry.Fugacity',
    special_qualifiers: ['species', 'mixture_composition'],
  },
  {
    key: 'thermodynamic.equilibrium_constant',
    label_ko: '평형상수',
    quantity_kind: 'chemistry.EquilibriumConstant',
    special_qualifiers: ['reaction', 'standard_state'],
  },
  {
    key: 'thermodynamic.osmotic_coefficient',
    label_ko: '삼투계수',
    quantity_kind: 'chemistry.OsmoticCoefficient',
    special_qualifiers: ['mixture_composition'],
  },
  {
    key: 'thermodynamic.osmotic_pressure',
    label_ko: '삼투압',
    quantity_kind: 'chemistry.OsmoticPressure',
    special_qualifiers: ['mixture_composition'],
  },
] as const)
