const domain = 'coupledPhenomena' as const

export const coupledPhenomenaQuantityKindData = {
  'coupledPhenomena.CouplingFactor': {
    domain,
    tensorOrder: 0,
    description:
      '"Coupling Factor" is the ratio of an electromagnetic quantity, usually voltage or current, appearing at a specified location of a given circuit to the corresponding quantity at a specified location in the circuit from which energy is transferred by coupling.',
    applicableUnits: ['{fraction}', '%'],
  },
  'coupledPhenomena.ElectricCurrentPerTemperature': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Current per Unit Temperature" is used to express how a current is subject to temperature. Originally used in Wien\'s Law to describe phenomena related to filaments. One use today is to express how a current generator derates with temperature.',
    applicableUnits: ['A.K-1', 'kA.K-1', 'uA.K-1', 'mA.K-1', 'nA.K-1'],
  },
  'coupledPhenomena.ElectricPotentialPerTemperature': {
    domain,
    tensorOrder: 0,
    description: 'electric potential divided by thermodynamic temperature',
    applicableUnits: ['V.K-1', 'mV.K-1', 'uV.K-1'],
  },
  'coupledPhenomena.ElectrostrictionCoefficient': {
    domain,
    tensorOrder: 4,
    description: 'strain per squared electric field',
    applicableUnits: ['m2.V-2', 'cm2.kV-2', 'mm2.kV-2'],
  },
  'coupledPhenomena.LinearVoltageCoefficient': {
    domain,
    tensorOrder: 0,
    description: 'ratio identifying the relationship between induced voltage and velocity',
    applicableUnits: ['A-1.m.kg.s-2'],
  },
  'coupledPhenomena.LorenzCoefficient': {
    domain,
    tensorOrder: 0,
    description: '"Lorenz Coefficient" is part mof the Lorenz curve.',
    applicableUnits: ['V2.K-2'],
  },
  'coupledPhenomena.MagnetoelectricCoefficient': {
    domain,
    tensorOrder: 2,
    description: 'electric response per magnetic excitation',
    applicableUnits: ['s.m-1', 'ms.m-1', 'us.m-1', 'ns.m-1', 'ps.m-1'],
  },
  'coupledPhenomena.PeltierCoefficient': {
    domain,
    tensorOrder: 2,
    description:
      '"Peltier Coefficient" represents how much heat current is carried per unit charge through a given material. It is the heat power developed at a junction, divided by the electric current flowing from substance a to substance b.',
    applicableUnits: ['A-1.m2.kg.s-3'],
  },
  'coupledPhenomena.PiezoelectricChargeCoefficient': {
    domain,
    tensorOrder: 3,
    description: 'strain per electric field, equivalently electric displacement per stress',
    applicableUnits: ['C.N-1', 'mC.N-1', 'uC.N-1', 'nC.N-1', 'pC.N-1', 'm.V-1', 'um.V-1', 'nm.V-1', 'pm.V-1'],
  },
  'coupledPhenomena.PiezoelectricStressCoefficient': {
    domain,
    tensorOrder: 3,
    description: 'stress per electric field, equivalently electric displacement per strain',
    applicableUnits: ['C.m-2', 'mC.m-2', 'uC.m-2', 'N.V-1.m-1', 'N.kV-1.mm-1'],
  },
  'coupledPhenomena.PiezoelectricVoltageCoefficient': {
    domain,
    tensorOrder: 3,
    description: 'electric field per stress, equivalently strain per electric displacement',
    applicableUnits: ['V.m.N-1', 'mV.m.N-1', 'V.mm.N-1', 'm2.C-1', 'cm2.C-1', 'mm2.C-1'],
  },
  'coupledPhenomena.PiezoresistiveCoefficient': {
    domain,
    tensorOrder: 4,
    description: 'relative resistivity change per stress',
    applicableUnits: ['Pa-1', 'kPa-1', 'MPa-1', 'GPa-1'],
  },
  'coupledPhenomena.PyroelectricCoefficient': {
    domain,
    tensorOrder: 1,
    description: 'electric polarization change per thermodynamic temperature change',
    applicableUnits: ['C.m-2.K-1', 'mC.m-2.K-1', 'uC.m-2.K-1', 'nC.m-2.K-1'],
  },
  'coupledPhenomena.SeebeckCoefficient': {
    domain,
    tensorOrder: 2,
    description:
      '"Seebeck Coefficient", or thermopower, or thermoelectric power of a material is a measure of the magnitude of an induced thermoelectric voltage in response to a temperature difference across that material.',
    applicableUnits: ['V.K-1'],
  },
  'coupledPhenomena.StressOpticCoefficient': {
    domain,
    tensorOrder: 0,
    description:
      'When a ray of light passes through a photoelastic material, its electromagnetic wave components are resolved along the two principal stress directions and each component experiences a different refractive index due to the birefringence. The difference in the refractive indices leads to a relative phase retardation between the two components. Assuming a thin specimen made of isotropic materials, where two-dimensional photoelasticity is applicable, the magnitude of the relative retardation is given by the stress-optic law Δ=((2πt)/λ)C(σ₁-σ₂), where Δ is the induced retardation, C is the stress-optic coefficient, t is the specimen thickness, λ is the vacuum wavelength, and σ₁ and σ₂ are the first and second principal stresses, respectively.',
    applicableUnits: ['nm.cm-1.MPa-1', 'nm.cm-1.[psi]-1', 'nm.mm-1.MPa-1'],
  },
  'coupledPhenomena.TemperaturePerMagneticFluxDensity': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['K.T-1'],
  },
  'coupledPhenomena.ThomsonCoefficient': {
    domain,
    tensorOrder: 0,
    description:
      '"Thomson Coefficient" represents Thomson heat power developed, divided by the electric current and the temperature difference.',
    applicableUnits: ['V.K-1'],
  },
} as const
