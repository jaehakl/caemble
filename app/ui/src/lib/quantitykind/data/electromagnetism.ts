const domain = 'electromagnetism' as const

export const electromagnetismQuantityKindData = {
  'electromagnetism.ActiveEnergy': {
    domain,
    tensorOrder: 0,
    description: '$\\textit{Active Energy}$ is the electrical energy transformable into some other form of energy.',
    applicableUnits: [
      'aJ',
      'EJ',
      'fJ',
      'GJ',
      'GW.h',
      'J',
      'kJ',
      'kW.h',
      'MJ',
      'MW.h',
      'uJ',
      'mJ',
      'nJ',
      'PJ',
      'pJ',
      'TJ',
      'TW.h',
      'W.h',
      'W.s',
    ],
  },
  'electromagnetism.ActivePower': {
    domain,
    tensorOrder: 0,
    description:
      'An $Active Power$ is, under periodic conditions, the mean value, taken over one period $T$, of the instantaneous power $p$. In complex notation, $P = \\mathbf{Re} \\; \\underline{S}$, where $\\underline{S}$ is $\\textit{complex power}$.',
    applicableUnits: ['EW', 'GW', 'kW', 'MW', 'uW', 'mW', 'nW', 'PW', 'pW', 'TJ.s-1', 'TW', 'W'],
  },
  'electromagnetism.Admittance': {
    domain,
    tensorOrder: 0,
    description:
      '"Admittance" is a measure of how easily a circuit or device will allow a current to flow. It is defined as the inverse of the impedance ($Z$).',
    applicableUnits: ['dS', 'kS', 'mho', 'MS', 'umho', 'uS', 'mS', 'nS', 'pS', 'S'],
  },
  'electromagnetism.ApparentEnergy': {
    domain,
    tensorOrder: 0,
    description:
      '"Apparent Energy" is the integral of apparent power over a time interval. Under sinusoidal conditions it equals the product of the rms voltage, the rms electric current, and the duration of the interval. It is the modulus of the complex energy $\\underline{W} = W_p + jW_q$, where $W_p$ is active energy and $W_q$ is reactive energy.',
    applicableUnits: ['m2.kg.s-2'],
  },
  'electromagnetism.ApparentPower': {
    domain,
    tensorOrder: 0,
    description:
      '"Apparent Power" is the product of the rms voltage $U$ between the terminals of a two-terminal element or two-terminal circuit and the rms electric current I in the element or circuit. Under sinusoidal conditions, the apparent power is the modulus of the complex power.',
    applicableUnits: ['m2.kg.s-3'],
  },
  'electromagnetism.AreaChargeDensity': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.AreicChargeDensityOrElectricFluxDensityOrElectricPolarization': {
    domain,
    tensorOrder: 1,
    description:
      'charge Q presented on an area of size A divided by the area A or vector quantity obtained at a given point by adding the electric polarization P to the product of the electric field strength E and the electric constant (permittivity) ε₀',
    applicableUnits: ['A.m-2.s'],
  },
  'electromagnetism.AuxillaryMagneticField': {
    domain,
    tensorOrder: 1,
    description:
      'Magnetic Fields surround magnetic materials and electric currents and are detected by the force they exert on other magnetic materials and moving electric charges. The electric and magnetic fields are two interrelated aspects of a single object, called the electromagnetic field. A pure electric field in one reference frame is observed as a combination of both an electric field and a magnetic field in a moving reference frame. The Auxillary Magnetic Field, H characterizes how the true Magnetic Field B influences the organization of magnetic dipoles in a given medium.',
    applicableUnits: ['A.cm-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1', 'Oe'],
  },
  'electromagnetism.BatteryCapacity': {
    domain,
    tensorOrder: 0,
    description:
      'quantity of electricity or electrical charge which a fully charged battery can supply under specified conditions as a product of discharge current and discharge time',
    applicableUnits: ['A.h', 'A.min', 'A.s', 'kA.h', 'mA.h'],
  },
  'electromagnetism.Capacitance': {
    domain,
    tensorOrder: 0,
    description:
      '"Capacitance" is the ability of a body to hold an electrical charge; it is quantified as the amount of electric charge stored for a given electric potential. Capacitance is a scalar-valued quantity.',
    applicableUnits: ['aF', 'F', 'GF', 'fF', 'kF', 'uF', 'mF', 'nF', 'pF'],
  },
  'electromagnetism.CapacitancePerArea': {
    domain,
    tensorOrder: 0,
    description: 'electric capacitance divided by area',
    applicableUnits: ['F.m-2', 'mF.m-2', 'uF.cm-2', 'uF.m-2', 'nF.cm-2', 'nF.m-2', 'pF.cm-2', 'pF.m-2'],
  },
  'electromagnetism.Coercivity': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Coercivity}$, also referred to as $\\textit{Coercive Field Strength}$, is the magnetic field strength to be applied to bring the magnetic flux density in a substance from its remaining magnetic flux density to zero. This is defined as the coercive field strength in a substance when either the magnetic flux density or the magnetic polarization and magnetization is brought from its value at magnetic saturation to zero by monotonic reduction of the applied magnetic field strength. The quantity which is brought to zero should be stated, and the appropriate symbol used: $H_{cB}$, $H_{cJ}$ or $H_{cM}$ for the coercivity relating to the magnetic flux density, the magnetic polarization or the magnetization respectively, where $H_{cJ} = H_{cM}$.',
    applicableUnits: ['A.cm-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1', 'Oe'],
  },
  'electromagnetism.ComplexPower': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Complex Power}$, under sinusoidal conditions, is the product of the phasor $\\mathbf{U}$ representing the voltage between the terminals of a linear two-terminal element, or two-terminal circuit and the complex conjugate of the phasor $I$ representing the electric current in the element or circuit.',
    applicableUnits: ['m2.kg.s-3'],
  },
  'electromagnetism.Conductance': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Conductance}$, for a resistive two-terminal element or two-terminal circuit with terminals A and B, quotient of the electric current i in the element or circuit by the voltage $u_{AB}$ between the terminals: $G = \\frac{1}{R}$, where the electric current is taken as positive if its direction is from A to B and negative in the opposite case. The conductance of an element or circuit is the inverse of its resistance.',
    applicableUnits: ['dS', 'kS', 'mho', 'MS', 'umho', 'uS', 'mS', 'nS', 'pS', 'S'],
  },
  'electromagnetism.Conductivity': {
    domain,
    tensorOrder: 2,
    description:
      '$\\textit{Conductivity}$ is a scalar or tensor quantity the product of which by the electric field strength in a medium is equal to the electric current density. For an isotropic medium the conductivity is a scalar quantity; for an anisotropic medium it is a tensor quantity. $$\\mathbf{J} = \\sigma \\mathbf{E}$$ Where $\\mathbf{J}$ is electric current density, and $\\mathbf{E}$ is electric field strength.',
    applicableUnits: ['A2.m-3.kg-1.s3'],
  },
  'electromagnetism.CubicElectricDipoleMomentPerSquareEnergy': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['C3.m.J-2'],
  },
  'electromagnetism.CurrentLinkage': {
    domain,
    tensorOrder: 0,
    description: '"Current Linkage" is the net electric current through a surface delimited by a closed loop.',
    applicableUnits: ['A', 'aA', 'fA', 'GA', 'PA', 'TA'],
  },
  'electromagnetism.CutoffCurrentRating': {
    domain,
    tensorOrder: 0,
    description:
      'cut-off current parameter as rating for fuses and switches, derived from the so-called Joule integral',
    applicableUnits: ['A2.s'],
  },
  'electromagnetism.DisplacementCurrent': {
    domain,
    tensorOrder: 0,
    description:
      '"Displacement Current" is a quantity appearing in Maxwell\'s equations that is defined in terms of the rate of change of electric displacement field. Displacement current has the units of electric current density, and it has an associated magnetic field just as actual currents do. However it is not an electric current of moving charges, but a time-varying electric field. In materials, there is also a contribution from the slight motion of charges bound in atoms, dielectric polarization.',
    applicableUnits: ['A', 'Bi', 'aA', 'fA', 'GA', 'kA', 'MA', 'uA', 'mA', 'nA', 'PA', 'pA', 'TA'],
  },
  'electromagnetism.DisplacementCurrentDensity': {
    domain,
    tensorOrder: 1,
    description:
      '$\\text{Displacement Current Density}$ is the time rate of change of the $\\textit{Electric Flux Density}$. This is a measure of how quickly the electric field changes if we observe it as a function of time. This is different than if we look at how the electric field changes spatially, that is, over a region of space for a fixed amount of time.',
    applicableUnits: ['A.m-2'],
  },
  'electromagnetism.ElectricalConductance': {
    domain,
    tensorOrder: 0,
    description:
      'measure of the capability of a material to conduct electric current, the value of which is defined as the reciprocal of the electrical resistance',
    applicableUnits: ['dS', 'kS', 'mho', 'MS', 'umho', 'uS', 'mS', 'nS', 'pS', 'S'],
  },
  'electromagnetism.ElectricalPowerToMassRatio': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['erg.g-1.s-1', 'mW.mg-1', 'W.g-1', 'W.kg-1'],
  },
  'electromagnetism.ElectricalResistance': {
    domain,
    tensorOrder: 0,
    description:
      'different properties of materials which impede the electrical current in its movement when the free charged particles in these materials are set in motion by electrical fields and/or electrical potentials',
    applicableUnits: ['nOhm'],
  },
  'electromagnetism.ElectricCharge': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Charge" is a fundamental conserved property of some subatomic particles, which determines their electromagnetic interaction. Electrically charged matter is influenced by, and produces, electromagnetic fields. The electric charge on a body may be positive or negative. Two positively charged bodies experience a mutual repulsive force, as do two negatively charged bodies. A positively charged body and a negatively charged body experience an attractive force. Electric charge is carried by discrete particles and can be positive or negative. The sign convention is such that the elementary electric charge $e$, that is, the charge of the proton, is positive. The SI derived unit of electric charge is the coulomb.',
    applicableUnits: [
      'A.h',
      'A.s',
      'aC',
      'C',
      '10.C',
      'cC',
      'daC',
      'dC',
      '[e]',
      'EC',
      'fC',
      'GC',
      'hC',
      'kA.h',
      'kC',
      'kJ.kV-1',
      'MC',
      'uC',
      'mA.h',
      'mA.s',
      'mC',
      'nC',
      'PC',
      'pC',
      'TC',
      'yC',
      'YC',
      'zC',
      'ZC',
    ],
  },
  'electromagnetism.ElectricChargeDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively.',
    applicableUnits: [
      'A.h.dm-3',
      'A.h.m-3',
      'C.cm-3',
      'C.m-3',
      'C.mm-3',
      'GC.m-3',
      'kC.m-3',
      'MC.m-3',
      'uC.m-3',
      'mC.m-3',
    ],
  },
  'electromagnetism.ElectricChargeLinearDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively.',
    applicableUnits: ['A.m-1.s'],
  },
  'electromagnetism.ElectricChargeLineDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively. The respective SI units are $C \\cdot $, $m^{-1}$, $C \\cdot m^{-2}$ or $C \\cdot m^{-3}$.',
    applicableUnits: ['C.m-1'],
  },
  'electromagnetism.ElectricChargePerAmountOfSubstance': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Charge Per Amount Of Substance" is the charge assocated with a given amount of substance. Un the ISO and SI systems this is $1 mol$.',
    applicableUnits: ['C.mol-1'],
  },
  'electromagnetism.ElectricChargePerArea': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively. The respective SI units are $C \\cdot m^{-1}$, $C \\cdot m^{-2}$ or $C \\cdot m^{-3}$.',
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.ElectricChargePerMass': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Charge Per Mass" is the charge associated with a specific mass of a substance. In the SI and ISO systems this is $1 kg$.',
    applicableUnits: ['A.h.kg-1', 'A.m2.J-1.s-1', 'C.kg-1', 'Hz.T-1', 'kR', 'MHz.T-1', 'mC.kg-1', 'mR', 'T-1.s-1', 'R'],
  },
  'electromagnetism.ElectricChargeSurfaceDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively.',
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.ElectricChargeVolumeDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively. The respective SI units are $C \\cdot m^{-1}$, $C \\cdot m^{-2}$ or $C \\cdot m^{-3}$.',
    applicableUnits: [
      'A.h.dm-3',
      'A.h.m-3',
      'C.cm-3',
      'C.m-3',
      'C.mm-3',
      'GC.m-3',
      'kC.m-3',
      'MC.m-3',
      'uC.m-3',
      'mC.m-3',
    ],
  },
  'electromagnetism.ElectricConductivity': {
    domain,
    tensorOrder: 2,
    description:
      "The quantity kind $\\textit{Electric Conductivity}$ or $\\textit{Specific Conductance}$ is a measure of a material's ability to conduct an electric current. When an electrical potential difference is placed across a conductor, its movable charges flow, giving rise to an electric current. The conductivity $\\sigma$ is defined as the ratio of the electric current density $J$ to the electric field, $E$: $J = \\sigma E$. In isotropic materials, conductivity is scalar-valued, however in general, conductivity is a tensor-valued quantity.",
    applicableUnits: [
      'dS.m-1',
      'kS.m-1',
      'MS.m-1',
      'uS.cm-1',
      'uS.m-1',
      'mS.cm-1',
      'mS.m-1',
      'nS.cm-1',
      'nS.m-1',
      'pS.m-1',
      'S.cm-1',
      'S.m-1',
    ],
  },
  'electromagnetism.ElectricCurrent': {
    domain,
    tensorOrder: 0,
    description:
      'The quantity kind $\\textit{Electric Current}$ is the flow (movement) of electric charge. The amount of electric current through some surface, for example, a section through a copper conductor, is defined as the amount of electric charge flowing through that surface over time. Current is a scalar-valued quantity. Electric current is one of the base quantities in the International System of Quantities, ISQ, on which the International System of Units, SI, is based.',
    applicableUnits: ['A', 'Bi', 'aA', 'fA', 'GA', 'kA', 'MA', 'uA', 'mA', 'nA', 'PA', 'pA', 'TA'],
  },
  'electromagnetism.ElectricCurrentDensity': {
    domain,
    tensorOrder: 1,
    description:
      '"Electric Current Density" is a measure of the density of flow of electric charge; it is the electric current per unit area of cross section. Electric current density is a vector-valued quantity. Electric current, $I$, through a surface $S$ is defined as $I = \\int_S J \\cdot e_n dA$, where $e_ndA$ is the vector surface element.',
    applicableUnits: ['A.cm-2', 'A.m-2', 'A.mm-2', 'Bi.cm-2', 'kA.m-2', 'MA.m-2'],
  },
  'electromagnetism.ElectricCurrentImbalance': {
    domain,
    tensorOrder: 0,
    description:
      'Electric current imbalance is the percentage deviation of individual phase currents from the average current across phases in a polyphase electrical system.',
    applicableUnits: ['%'],
  },
  'electromagnetism.ElectricCurrentPerAngle': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.rad-1'],
  },
  'electromagnetism.ElectricCurrentPerEnergy': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.J-1'],
  },
  'electromagnetism.ElectricCurrentPerLength': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1'],
  },
  'electromagnetism.ElectricCurrentPhasor': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Current Phasor" is a representation of current as a sinusoidal integral quantity using a complex quantity whose argument is equal to the initial phase and whose modulus is equal to the root-mean-square value. A phasor is a constant complex number, usually expressed in exponential form, representing the complex amplitude (magnitude and phase) of a sinusoidal function of time. Phasors are used by electrical engineers to simplify computations involving sinusoids, where they can often reduce a differential equation problem to an algebraic one.',
    applicableUnits: ['A', 'aA', 'fA', 'GA', 'PA', 'TA'],
  },
  'electromagnetism.ElectricDipoleMoment': {
    domain,
    tensorOrder: 1,
    description:
      '"Electric Dipole Moment" is a measure of the separation of positive and negative electrical charges in a system of (discrete or continuous) charges. It is a vector-valued quantity. If the system of charges is neutral, that is if the sum of all charges is zero, then the dipole moment of the system is independent of the choice of a reference frame; however in a non-neutral system, such as the dipole moment of a single proton, a dependence on the choice of reference point arises. In such cases it is conventional to choose the reference point to be the center of mass of the system or the center of charge, not some arbitrary origin. This convention ensures that the dipole moment is an intrinsic property of the system. The electric dipole moment of a substance within a domain is the vector sum of electric dipole moments of all electric dipoles included in the domain.',
    applicableUnits: ['C.m'],
  },
  'electromagnetism.ElectricDipoleMoment_CubicPerEnergy_Squared': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A3.m-3.kg-2.s7'],
  },
  'electromagnetism.ElectricDipoleMoment_QuarticPerEnergy_Cubic': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A4.m-2.kg-3.s10'],
  },
  'electromagnetism.ElectricDisplacement': {
    domain,
    tensorOrder: 1,
    description:
      'In a dielectric material the presence of an electric field E causes the bound charges in the material (atomic nuclei and their electrons) to slightly separate, inducing a local electric dipole moment. The Electric Displacement Field, $D$, is a vector field that accounts for the effects of free charges within such dielectric materials. This describes also the charge density on an extended surface that could be causing the field.',
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.ElectricDisplacementField': {
    domain,
    tensorOrder: 1,
    description: undefined,
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.ElectricEnergy': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Energy" is the energy transferred to or from an electrical circuit over a time interval. It is the integral of electric power over time. In AC circuits it manifests in three specialised forms: active energy ($W_p$), which represents energy convertible to other forms; apparent energy ($W_a = |\\underline{W}|$); and reactive energy ($W_q$), which represents energy exchanged with reactive elements. Electric energy is commonly measured in watt-hours (Wh) or kilowatt-hours (kWh).',
    applicableUnits: [
      'aJ',
      'EJ',
      'fJ',
      'GJ',
      'GW.h',
      'J',
      'kJ',
      'kW.h',
      'MJ',
      'MW.h',
      'uJ',
      'mJ',
      'nJ',
      'PJ',
      'pJ',
      'TJ',
      'TW.h',
      'W.h',
      'W.s',
    ],
  },
  'electromagnetism.ElectricField': {
    domain,
    tensorOrder: 1,
    description:
      "The space surrounding an electric charge or in the presence of a time-varying magnetic field has a property called an electric field. This electric field exerts a force on other electrically charged objects. In the idealized case, the force exerted between two point charges is inversely proportional to the square of the distance between them. (Coulomb's Law).",
    applicableUnits: ['V.m-1', '10.nV.cm-1'],
  },
  'electromagnetism.ElectricFieldStrength': {
    domain,
    tensorOrder: 1,
    description:
      '$\\textit{Electric Field Strength}$ is the magnitude and direction of an electric field, expressed by the value of $E$, also referred to as $\\color{indigo} {\\textit{electric field intensity}}$ or simply the electric field.',
    applicableUnits: ['kV.m-1', 'MV.m-1', 'uV.m-1', 'mV.m-1', 'V.cm-1', 'V.[in_i]-1', 'V.m-1', 'V.mm-1', '10.nV.cm-1'],
  },
  'electromagnetism.ElectricFlux': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Flux" through an area is defined as the electric field multiplied by the area of the surface projected in a plane perpendicular to the field. Electric Flux is a scalar-valued quantity.',
    applicableUnits: ['V.m'],
  },
  'electromagnetism.ElectricFluxDensity': {
    domain,
    tensorOrder: 1,
    description:
      '$\\textit{Electric Flux Density}$, also referred to as $\\textit{Electric Displacement}$, is related to electric charge density by the following equation: $\\text{div} \\; D = \\rho$, where $\\text{div}$ denotes the divergence.',
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.ElectricPolarizability': {
    domain,
    tensorOrder: 2,
    description:
      '"Electric Polarizability" is the relative tendency of a charge distribution, like the electron cloud of an atom or molecule, to be distorted from its normal shape by an external electric field, which is applied typically by inserting the molecule in a charged parallel-plate capacitor, but may also be caused by the presence of a nearby ion or dipole.',
    applicableUnits: ['J.mol-1'],
  },
  'electromagnetism.ElectricPolarization': {
    domain,
    tensorOrder: 1,
    description:
      '"Electric Polarization" is the relative shift of positive and negative electric charge in opposite directions within an insulator, or dielectric, induced by an external electric field. Polarization occurs when an electric field distorts the negative cloud of electrons around positive atomic nuclei in a direction opposite the field. This slight separation of charge makes one side of the atom somewhat positive and the opposite side somewhat negative. In some materials whose molecules are permanently polarized by chemical forces, such as water molecules, some of the polarization is caused by molecules rotating into the same alignment under the influence of the electric field. One of the measures of polarization is electric dipole moment, which equals the distance between the slightly shifted centres of positive and negative charge multiplied by the amount of one of the charges. Polarization P in its quantitative meaning is the amount of dipole moment p per unit volume V of a polarized material, P = p/V.',
    applicableUnits: ['A.h.m-2', 'C.m-2', 'kC.m-2'],
  },
  'electromagnetism.ElectricPotential': {
    domain,
    tensorOrder: 0,
    description:
      'The Electric Potential is a scalar valued quantity associated with an electric field. The electric potential $\\phi(x)$ at a point, $x$, is formally defined as the line integral of the electric field taken along a path from x to the point at infinity. If the electric field is static, that is time independent, then the choice of the path is arbitrary; however if the electric field is time dependent, taking the integral a different paths will produce different results.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.ElectricPotentialDifference': {
    domain,
    tensorOrder: 0,
    description: '"Electric Potential Difference" is a scalar valued quantity associated with an electric field.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.ElectricPower': {
    domain,
    tensorOrder: 0,
    description:
      '"Electric Power" is the rate at which electrical energy is transferred by an electric circuit. In the simple case of direct current circuits, electric power can be calculated as the product of the potential difference in the circuit (V) and the amount of current flowing in the circuit (I): $P = VI$, where $P$ is the power, $V$ is the potential difference, and $I$ is the current. However, in general electric power is calculated by taking the integral of the vector cross-product of the electrical and magnetic fields over a specified area.',
    applicableUnits: ['EW', 'GW', 'kW', 'MW', 'uW', 'mW', 'nW', 'PW', 'pW', 'TJ.s-1', 'TW', 'W'],
  },
  'electromagnetism.ElectricQuadrupoleMoment': {
    domain,
    tensorOrder: 2,
    description:
      'The Electric Quadrupole Moment is a quantity which describes the effective shape of the ellipsoid of nuclear charge distribution. A non-zero quadrupole moment Q indicates that the charge distribution is not spherically symmetric. By convention, the value of Q is taken to be positive if the ellipsoid is prolate and negative if it is oblate. In general, the electric quadrupole moment is tensor-valued.',
    applicableUnits: ['C.m2'],
  },
  'electromagnetism.ElectricSusceptibility': {
    domain,
    tensorOrder: 2,
    description:
      '"Electric Susceptibility" is the ratio of electric polarization to electric field strength, normalized to the electric constant. The definition applies to an isotropic medium. For an anisotropic medium, electric susceptibility is a second order tensor.',
    applicableUnits: ['1'],
  },
  'electromagnetism.ElectromagneticEnergyDensity': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Electromagnetic Energy Density}$, also known as the $\\color{indigo} {\\text{Volumic Electromagnetic Energy}}$, is the energy associated with an electromagnetic field, per unit volume of the field.',
    applicableUnits: ['J.m-3'],
  },
  'electromagnetism.ElectromagneticPermeability': {
    domain,
    tensorOrder: 2,
    description:
      '$\\textit{Permeability}$ is the degree of magnetization of a material that responds linearly to an applied magnetic field. In general permeability is a tensor-valued quantity. The definition given applies to an isotropic medium. For an anisotropic medium permeability is a second order tensor. In electromagnetism, permeability is the measure of the ability of a material to support the formation of a magnetic field within itself. In other words, it is the degree of magnetization that a material obtains in response to an applied magnetic field. Magnetic permeability is typically represented by the Greek letter $\\mu$. The term was coined in September, 1885 by Oliver Heaviside. The reciprocal of magnetic permeability is $\\textit{Magnetic Reluctivity}$.',
    applicableUnits: ['H.m-1', 'uH.m-1', 'nH.m-1'],
  },
  'electromagnetism.ElectromagneticPermeabilityRatio': {
    domain,
    tensorOrder: 2,
    description:
      '$\\textit{Electromagnetic Permeability Ratio}$ is the ratio of the electromagnetic permeability of a specific medium to the electromagnetic permeability of free space.',
    applicableUnits: ['[mu_0]'],
  },
  'electromagnetism.ElectromagneticWavePhaseSpeed': {
    domain,
    tensorOrder: 0,
    description: '$\\textit{Electromagnetic Wave Phase Speed}$ is the ratio of angular velocity and wavenumber.',
    applicableUnits: ['[in_i].a-1', 'm.s-1', 'um.min-1', 'um.s-1', '[yd_i].h-1', '[yd_i].min-1', '[yd_i].s-1'],
  },
  'electromagnetism.ElectromotiveForce': {
    domain,
    tensorOrder: 0,
    description:
      'In physics, $\\textit{Electromotive Force}$, or most commonly $emf$ (seldom capitalized), or (occasionally) electromotance is that which tends to cause current (actual electrons and ions) to flow. More formally, $emf$ is the external work expended per unit of charge to produce an electric potential difference across two open-circuited terminals. $\\textit{Electromotive Force}$ is deprecated in the ISO System of Quantities.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.EnergyPerAreaElectricCharge': {
    domain,
    tensorOrder: 0,
    description: '"Energy Per Area Electric Charge" is the amount of electric energy associated with a unit of area.',
    applicableUnits: ['V.m-2'],
  },
  'electromagnetism.EnergyPerElectricCharge': {
    domain,
    tensorOrder: 0,
    description:
      'Voltage is a representation of the electric potential energy per unit charge. If a unit of electrical charge were placed in a location, the voltage indicates the potential energy of it at that point. In other words, it is a measurement of the energy contained within an electric field, or an electric circuit, at a given point. Voltage is a scalar quantity. The SI unit of voltage is the volt, such that $1 volt = 1 joule/coulomb$.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.EnergyPerMagneticFluxDensity_Squared': {
    domain,
    tensorOrder: 0,
    description:
      '"Energy Per Square Magnetic Flux Density" is a measure of energy for a unit of magnetic flux density.',
    applicableUnits: ['A2.m2.kg-1.s2'],
  },
  'electromagnetism.EnergyPerSquareMagneticFluxDensity': {
    domain,
    tensorOrder: 0,
    description:
      '"Energy Per Square Magnetic Flux Density" is a measure of energy for a unit of magnetic flux density.',
    applicableUnits: ['J.T-2'],
  },
  'electromagnetism.ForcePerElectricCharge': {
    domain,
    tensorOrder: 1,
    description:
      'The electric field depicts the force exerted on other electrically charged objects by the electrically charged particle the field is surrounding. The electric field is a vector field with SI units of newtons per coulomb ($N C^{-1}$) or, equivalently, volts per metre ($V m^{-1}$ ). The SI base units of the electric field are $kg m s^{-3} A^{-1}$. The strength or magnitude of the field at a given point is defined as the force that would be exerted on a positive test charge of 1 coulomb placed at that point',
    applicableUnits: ['N.C-1'],
  },
  'electromagnetism.HallCoefficient': {
    domain,
    tensorOrder: 0,
    description:
      '"Hall Coefficient" is defined as the ratio of the induced electric field to the product of the current density and the applied magnetic field.',
    applicableUnits: ['m3.C-1', 'V.[in_i]2.[lbf_av]-1', 'V.bar-1', 'V.Pa-1'],
  },
  'electromagnetism.Impedance': {
    domain,
    tensorOrder: 0,
    description:
      '"Impedance" is the measure of the opposition that a circuit presents to the passage of a current when a voltage is applied. In quantitative terms, it is the complex ratio of the voltage to the current in an alternating current (AC) circuit. Impedance extends the concept of resistance to AC circuits, and possesses both magnitude and phase, unlike resistance, which has only magnitude. When a circuit is driven with direct current (DC), there is no distinction between impedance and resistance; the latter can be thought of as impedance with zero phase angle.',
    applicableUnits: ['Ohm'],
  },
  'electromagnetism.Inductance': {
    domain,
    tensorOrder: 0,
    description:
      '"Inductance" is an electromagentic quantity that characterizes a circuit\'s resistance to any change of electric current; a change in the electric current through induces an opposing electromotive force (EMF). Quantitatively, inductance is proportional to the magnetic flux per unit of electric current.',
    applicableUnits: ['H', 'nH', 'kH', 'uH', 'mH', 'pH'],
  },
  'electromagnetism.InductanceBasedTimeConstant': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['s'],
  },
  'electromagnetism.InstantaneousPower': {
    domain,
    tensorOrder: 0,
    description:
      'For a two-terminal element or a two-terminal circuit with terminals A and B, $\\textit{Instantaneous Power}$ is the product of the voltage $u_{AB}$ between the terminals and the electric current i in the element or circuit: $$p = u_{AB} \\cdot i$$ Where $u_{AB}$ is the line integral of the electric field strength from A to B, and where the electric current in the element or circuit is taken positive if its direction is from A to B and negative in the opposite case. $$$$ For an n-terminal circuit, it is the sum of the instantaneous powers relative to the n - 1 pairs of terminals when one of the terminals is chosen as a common terminal for the pairs. $$$$ For a polyphase element, it is the sum of the instantaneous powers in all phase elements of a polyphase element. $$$$ For a polyphase line consisting of m line conductors and one neutral conductor, it is the sum of the m instantaneous powers expressed for each line conductor by the product of the polyphase line-to-neutral voltage and the corresponding line current.',
    applicableUnits: ['EW', 'GW', 'kW', 'MW', 'uW', 'mW', 'nW', 'PW', 'pW', 'TJ.s-1', 'TW', 'W'],
  },
  'electromagnetism.InverseMagneticFlux': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['Hz.V-1', 'Wb-1'],
  },
  'electromagnetism.InversePermittivity': {
    domain,
    tensorOrder: 2,
    description: undefined,
    applicableUnits: ['m.F-1'],
  },
  'electromagnetism.LengthPerElectricCurrent': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A-1.m'],
  },
  'electromagnetism.LinearElectricCharge': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.m-1.s'],
  },
  'electromagnetism.LinearElectricChargeDensity': {
    domain,
    tensorOrder: 0,
    description:
      'In electromagnetism, charge density is a measure of electric charge per unit volume of space, in one, two or three dimensions. More specifically: the linear, surface, or volume charge density is the amount of electric charge per unit length, surface area, or volume, respectively.',
    applicableUnits: ['C.m-1'],
  },
  'electromagnetism.LinearElectricCurrent': {
    domain,
    tensorOrder: 0,
    description: '"Linear Electric Linear Current" is the electric current per unit line.',
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1'],
  },
  'electromagnetism.LinearElectricCurrentDensity': {
    domain,
    tensorOrder: 1,
    description:
      '"Linear Electric Linear Current Density" is the electric current per unit length. Electric current, $I$, through a curve $C$ is defined as $I = \\int_C J _s \\times e_n$, where $e_n$ is a unit vector perpendicular to the surface and line vector element, and $dr$ is the differential of position vector $r$.',
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1'],
  },
  'electromagnetism.LinearResistance': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: [
      'GOhm.m-1',
      'kOhm.m-1',
      'MOhm.km-1',
      'MOhm.m-1',
      'mOhm.m-1',
      'Ohm.km-1',
      'Ohm.m-1',
      'Ohm.[mi_i]-1',
    ],
  },
  'electromagnetism.LineicCharge': {
    domain,
    tensorOrder: 0,
    description: 'electric charge divided by related length',
    applicableUnits: ['A.m-1.s'],
  },
  'electromagnetism.LineicResistance': {
    domain,
    tensorOrder: 0,
    description: 'ratio of resistance divided by length',
    applicableUnits: ['Ohm.m-1'],
  },
  'electromagnetism.LinkedFlux': {
    domain,
    tensorOrder: 0,
    description:
      '"Linked Flux" is defined as the path integral of the magnetic vector potential. This is the line integral of a magnetic vector potential $A$ along a curve $C$. The line vector element $dr$ is the differential of position vector $r$.',
    applicableUnits: ['k[lbf_av].[ft_i].A-1', 'kWb', 'Mx', 'mWb', 'N.m.A-1', '10.nV.s', 'Wb'],
  },
  'electromagnetism.LossAngle': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ["'", "''", 'deg', 'gon', 'urad', 'mrad', 'rad'],
  },
  'electromagnetism.MagneticAreaMoment': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetic Area Moment", for a magnetic dipole, is a vector quantity equal to the product of the current, the loop area, and the unit vector normal to the loop plane, the direction of which corresponds to the loop orientation. "Magnetic Area Moment" is also referred to as "Magnetic Moment".',
    applicableUnits: ['A.m2', 'Bi.cm2', 'eV.T-1', 'J.T-1'],
  },
  'electromagnetism.MagneticDipoleMoment': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetic Dipole Moment" is the magnetic moment of a system is a measure of the magnitude and the direction of its magnetism. Magnetic moment usually refers to its Magnetic Dipole Moment, and quantifies the contribution of the system\'s internal magnetism to the external dipolar magnetic field produced by the system (that is, the component of the external magnetic field that is inversely proportional to the cube of the distance to the observer). The Magnetic Dipole Moment is a vector-valued quantity. For a particle or nucleus, vector quantity causing an increment $\\Delta W = -\\mu \\cdot B$ to its energy $W$ in an external magnetic field with magnetic flux density $B$.',
    applicableUnits: ['N.m2.A-1', 'Wb.m'],
  },
  'electromagnetism.MagneticDipoleMomentOfAMolecule': {
    domain,
    tensorOrder: 1,
    description:
      'Em = -m•B, where Em is the interaction energy of the molecule with the magnetic dipole moment m and a magnetic field with the magnetic induced flux density B',
    applicableUnits: ['A.m2'],
  },
  'electromagnetism.MagneticField': {
    domain,
    tensorOrder: 1,
    description:
      'The Magnetic Field, denoted $B$, is a fundamental field in electrodynamics which characterizes the magnetic force exerted by electric currents. It is closely related to the auxillary magnetic field H.',
    applicableUnits: ['G', 'kG', 'kT', 'uT', 'mT', 'nT', 'T'],
  },
  'electromagnetism.MagneticFieldStrength': {
    domain,
    tensorOrder: 1,
    description:
      '$\\textit{Magnetic Field Strength}$ is a vector quantity obtained at a given point by subtracting the magnetization $M$ from the magnetic flux density $B$ divided by the magnetic constant $\\mu_0$. The magnetic field strength is related to the total current density $J_{tot}$ via: $\\text{rot} H = J_{tot}$.',
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1', 'Oe'],
  },
  'electromagnetism.MagneticFieldStrength_H': {
    domain,
    tensorOrder: 1,
    description:
      '$\\textit{Magnetic Field Strength}$ is a vector quantity obtained at a given point by subtracting the magnetization $M$ from the magnetic flux density $B$ divided by the magnetic constant $\\mu_0$. The magnetic field strength is related to the total current density $J_{tot}$ via: $\\text{rot} H = J_{tot}$.',
    applicableUnits: ['A.m-1'],
  },
  'electromagnetism.MagneticFlux': {
    domain,
    tensorOrder: 0,
    description:
      '"Magnetic Flux" is the product of the average magnetic field times the perpendicular area that it penetrates.',
    applicableUnits: ['k[lbf_av].[ft_i].A-1', 'kWb', 'Mx', 'mWb', 'N.m.A-1', '10.nV.s', 'Wb'],
  },
  'electromagnetism.MagneticFluxDensity': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetic Flux Density" is a vector quantity and is the magnetic flux per unit area of a magnetic field at right angles to the magnetic force. It can be defined in terms of the effects the field has, for example by $B = F/q v \\sin \\theta$, where $F$ is the force a moving charge $q$ would experience if it was travelling at a velocity $v$ in a direction making an angle θ with that of the field. The magnetic field strength is also a vector quantity and is related to $B$ by: $H = B/\\mu$, where $\\mu$ is the permeability of the medium.',
    applicableUnits: ['G', 'kG', 'kT', 'uT', 'mT', 'nT', 'T'],
  },
  'electromagnetism.MagneticFluxDensityOrMagneticPolarization': {
    domain,
    tensorOrder: 1,
    description:
      'field vector B which exhibits a force F on any charged particle which has a velocity v, where the force is the product of the vector product v x B and the electric charge Q of the particle or vector quantity equal to the product of the magnetization M and the magnetic constant µ₀',
    applicableUnits: ['A-1.kg.s-2'],
  },
  'electromagnetism.MagneticFluxPerLength': {
    domain,
    tensorOrder: 0,
    description: '"Magnetic Flux per Length" is a quantity in the SI and C.G.S. Systems of Quantities.',
    applicableUnits: ['N.A-1', 'T.m', 'V.s.m-1'],
  },
  'electromagnetism.MagneticMoment': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetic Moment", for a magnetic dipole, is a vector quantity equal to the product of the current, the loop area, and the unit vector normal to the loop plane, the direction of which corresponds to the loop orientation. "Magnetic Moment" is also referred to as "Magnetic Area Moment", and is not to be confused with Magnetic Dipole Moment.',
    applicableUnits: ['A.m2', 'Bi.cm2', 'eV.T-1', 'J.T-1'],
  },
  'electromagnetism.MagneticPolarization': {
    domain,
    tensorOrder: 1,
    description:
      '$\\text{Magnetic Polarization}$ is a vector quantity equal to the product of the magnetization $M$ and the magnetic constant $\\mu_0$.',
    applicableUnits: ['A.m-1'],
  },
  'electromagnetism.MagneticReluctivity': {
    domain,
    tensorOrder: 2,
    description:
      '"Length Per Unit Magnetic Flux" is the the resistance of a material to the establishment of a magnetic field in it. It is the reciprocal of $\\textit{Magnetic Permeability}$, the inverse of the measure of the ability of a material to support the formation of a magnetic field within itself.',
    applicableUnits: ['m.V-1.s-1', 'T-1.m-1'],
  },
  'electromagnetism.MagneticSusceptability': {
    domain,
    tensorOrder: 2,
    description:
      '"Magnetic Susceptability" is a scalar or tensor quantity the product of which by the magnetic constant $\\mu_0$ and by the magnetic field strength $H$ is equal to the magnetic polarization $J$. The definition given applies to an isotropic medium. For an anisotropic medium permeability is a second order tensor.',
    applicableUnits: ['1'],
  },
  'electromagnetism.MagneticTension': {
    domain,
    tensorOrder: 0,
    description:
      '"Magnetic Tension" is a scalar quantity equal to the line integral of the magnetic field strength $\\mathbf{H}$ along a specified path linking two points a and b.',
    applicableUnits: ['A', 'aA', 'fA', 'GA', 'PA', 'TA'],
  },
  'electromagnetism.MagneticVectorPotential': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetic Vector Potential" is the vector potential of the magnetic flux density. The magnetic vector potential is not unique since any irrotational vector field quantity can be added to a given magnetic vector potential without changing its rotation. Under static conditions the magnetic vector potential is often chosen so that its divergence is zero.',
    applicableUnits: ['kWb.m-1', 'V.s.m-1', 'Wb.m-1', 'Wb.mm-1'],
  },
  'electromagnetism.Magnetization': {
    domain,
    tensorOrder: 1,
    description:
      '"Magnetization" is defined as the ratio of magnetic moment per unit volume. It is a vector-valued quantity.',
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1'],
  },
  'electromagnetism.MagnetizationField': {
    domain,
    tensorOrder: 1,
    description:
      'The Magnetization Field is defined as the ratio of magnetic moment per unit volume. It is a vector-valued quantity.',
    applicableUnits: ['A.cm-1', 'A.m-1', 'A.mm-1', 'kA.m-1', 'mA.[in_i]-1', 'mA.mm-1'],
  },
  'electromagnetism.MagnetomotiveForce': {
    domain,
    tensorOrder: 0,
    description:
      '$\\text{Magnetomotive Force}$, also referred to as ($mmf$), is the ability of an electric circuit to produce magnetic flux. Just as the ability of a battery to produce electric current is called its electromotive force or emf, mmf is taken as the work required to move a unit magnet pole from any point through any path which links the electric circuit back the same point in the presence of the magnetic force produced by the electric current in the circuit. $\\text{Magnetomotive Force}$ is the scalar line integral of the magnetic field strength along a closed path.',
    applicableUnits: ['Gb', 'Oe.cm'],
  },
  'electromagnetism.MassicElectricCurrent': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.kg-1'],
  },
  'electromagnetism.MassPerElectricCharge': {
    domain,
    tensorOrder: 0,
    description:
      'The mass-to-charge ratio ratio ($m/Q$) is a physical quantity that is widely used in the electrodynamics of charged particles, for example, in electron optics and ion optics. The importance of the mass-to-charge ratio, according to classical electrodynamics, is that two particles with the same mass-to-charge ratio move in the same path in a vacuum when subjected to the same electric and magnetic fields. Its SI units are $kg/C$, but it can also be measured in Thomson ($Th$).',
    applicableUnits: ['T.s'],
  },
  'electromagnetism.MassRelatedElectricalCurrent': {
    domain,
    tensorOrder: 0,
    description: 'electrical current intensity divided by the associated mass',
    applicableUnits: ['A.kg-1'],
  },
  'electromagnetism.ModulusOfAdmittance': {
    domain,
    tensorOrder: 0,
    description: '"Modulus Of Admittance" is the absolute value of the quantity "admittance".',
    applicableUnits: ['A2.m-2.kg-1.s3'],
  },
  'electromagnetism.ModulusOfImpedance': {
    domain,
    tensorOrder: 0,
    description:
      '"Modulus Of Impedance} is the absolute value of the quantity $\\textit{impedance}$. Apparent impedance is defined more generally as the quotient of rms voltage and rms electric current; it is often denoted by $Z$.',
    applicableUnits: ['Ohm'],
  },
  'electromagnetism.MutualInductance': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Mutual Inductance}$ is the non-diagonal term of the inductance matrix. For two loops, the symbol $M$ is used for $L_{12}$.',
    applicableUnits: ['H', 'nH', 'kH', 'uH', 'mH', 'pH'],
  },
  'electromagnetism.NonActivePower': {
    domain,
    tensorOrder: 0,
    description:
      '"Non-active Power", for a two-terminal element or a two-terminal circuit under periodic conditions, is the quantity equal to the square root of the difference of the squares of the apparent power and the active power.',
    applicableUnits: ['m2.kg.s-3'],
  },
  'electromagnetism.NumberOfElectricalPhases': {
    domain,
    tensorOrder: 0,
    description: '"Number of Electrical Phases" is used to characterize AC electrical service to a facility.',
    applicableUnits: ['{#}'],
  },
  'electromagnetism.Permittivity': {
    domain,
    tensorOrder: 2,
    description:
      '"Permittivity" is a physical quantity that describes how an electric field affects, and is affected by a dielectric medium, and is determined by the ability of a material to polarize in response to the field, and thereby reduce the total electric field inside the material. Permittivity is often a scalar valued quantity, however in the general case it is tensor-valued.',
    applicableUnits: ['F.km-1', 'F.m-1', 'GF.cm-1', 'uF.km-1', 'uF.m-1', 'nF.m-1', 'pF.m-1'],
  },
  'electromagnetism.PermittivityRatio': {
    domain,
    tensorOrder: 2,
    description: '"Permittivity Ratio" is the ratio of permittivity to the permittivity of a vacuum.',
    applicableUnits: ['{fraction}', '%'],
  },
  'electromagnetism.Polarizability': {
    domain,
    tensorOrder: 2,
    description:
      '"Polarizability" is the relative tendency of a charge distribution, like the electron cloud of an atom or molecule, to be distorted from its normal shape by an external electric field, which may be caused by the presence of a nearby ion or dipole. The electronic polarizability $\\alpha$ is defined as the ratio of the induced dipole moment of an atom to the electric field that produces this dipole moment. Polarizability is often a scalar valued quantity, however in the general case it is tensor-valued.',
    applicableUnits: ['C.m2.V-1', 'C2.m2.J-1'],
  },
  'electromagnetism.PolarizationField': {
    domain,
    tensorOrder: 1,
    description:
      'The Polarization Field is the vector field that expresses the density of permanent or induced electric dipole moments in a dielectric material. The polarization vector P is defined as the ratio of electric dipole moment per unit volume.',
    applicableUnits: ['A.h.m-2', 'C.cm-2', 'C.m-2', 'C.mm-2', '10.C.cm-2', 'kC.m-2', 'MC.m-2', 'uC.m-2', 'mC.m-2'],
  },
  'electromagnetism.PowerConstant': {
    domain,
    tensorOrder: 0,
    description: 'ratio indicating the relationship between continuous power and continuous current',
    applicableUnits: ['A-1.m.kg.s-2'],
  },
  'electromagnetism.PowerFactor': {
    domain,
    tensorOrder: 0,
    description:
      '"Power Factor", under periodic conditions, is the ratio of the absolute value of the active power $P$ to the apparent power $S$.',
    applicableUnits: ['{fraction}', '%'],
  },
  'electromagnetism.PowerPerElectricCharge': {
    domain,
    tensorOrder: 0,
    description: '"Power Per Electric Charge" is the amount of energy generated by a unit of electric charge.',
    applicableUnits: ['mV.min-1', 'V.us-1', 'V.s-1'],
  },
  'electromagnetism.PoyntingVector': {
    domain,
    tensorOrder: 1,
    description:
      'A $\\textit{Poynting Vector}$ is the vector product of the electric field strength $\\mathbf{E}$ and the magnetic field strength $\\mathbf{H}$ of the electromagnetic field at a given point. The flux of the Poynting vector through a closed surface is equal to the electromagnetic power passing through this surface. For a periodic electromagnetic field, the time average of the Poynting vector is a vector of which, with certain reservations, the direction may be considered as being the direction of propagation of electromagnetic energy and the magnitude considered as being the average electromagnetic power flux density.',
    applicableUnits: ['nW.m-2', 'W.m-2'],
  },
  'electromagnetism.PressureBasedElectricCurrent': {
    domain,
    tensorOrder: 0,
    description: 'ratio of electric current divided by the related pressure',
    applicableUnits: ['A.Pa-1'],
  },
  'electromagnetism.PressureBasedElectricVoltage': {
    domain,
    tensorOrder: 0,
    description: 'ratio of electric voltage divided by the related pressure',
    applicableUnits: ['A-1.m3.s-1'],
  },
  'electromagnetism.PropagationCoefficient': {
    domain,
    tensorOrder: 0,
    description:
      'The propagation constant, symbol $\\gamma$, for a given system is defined by the ratio of the amplitude at the source of the wave to the amplitude at some distance x.',
    applicableUnits: ['km-1', 'm-1', 'um-1', 'mm-1', 'nm-1', 'pm-1'],
  },
  'electromagnetism.QuarticElectricDipoleMomentPerCubicEnergy': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['C4.m4.J-3'],
  },
  'electromagnetism.RateOfRiseOfOffStateVoltage': {
    domain,
    tensorOrder: 0,
    description: 'du/dt as time dependent change in voltage',
    applicableUnits: ['A-1.m2.kg.s-4'],
  },
  'electromagnetism.RateOfRiseOfVoltage': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A-1.m2.kg.s-4'],
  },
  'electromagnetism.Reactance': {
    domain,
    tensorOrder: 0,
    description:
      "$\\textit{Reactance}$ is the opposition of a circuit element to a change of electric current or voltage, due to that element's inductance or capacitance. A built-up electric field resists the change of voltage on the element, while a magnetic field resists the change of current. The notion of reactance is similar to electrical resistance, but they differ in several respects. Capacitance and inductance are inherent properties of an element, just like resistance.",
    applicableUnits: ['Ohm'],
  },
  'electromagnetism.ReactiveCharge': {
    domain,
    tensorOrder: 0,
    description:
      'Reactive charge is the amount of chemical unit charge, positive or negative, that reactive species donate, accept, or exchange in a chemical process. It counts stoichiometric charge units rather than particles and is expressed in equivalents or moles of charge.',
    applicableUnits: ['mol'],
  },
  'electromagnetism.ReactiveChargePerMass': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['mol.kg-1'],
  },
  'electromagnetism.ReactiveEnergy': {
    domain,
    tensorOrder: 0,
    description:
      '"Reactive Energy" is the integral of reactive power over a time interval. It represents the energy exchanged between the source and reactive elements (inductors and capacitors) in an AC circuit. In complex notation, $W_q = \\mathrm{Im}\\,\\underline{W}$, where $\\underline{W}$ is complex energy.',
    applicableUnits: ['m2.kg.s-2'],
  },
  'electromagnetism.ReactivePower': {
    domain,
    tensorOrder: 0,
    description:
      '"Reactive Power", for a linear two-terminal element or two-terminal circuit, under sinusoidal conditions, is the quantity equal to the product of the apparent power $S$ and the sine of the displacement angle $\\psi$. The absolute value of the reactive power is equal to the non-active power. The ISO (and SI) unit for reactive power is the voltampere. The special name $\\textit{var}$ and symbol $\\textit{var}$ are given in IEC 60027 1.',
    applicableUnits: ['m2.kg.s-3'],
  },
  'electromagnetism.ReciprocalElectricResistance': {
    domain,
    tensorOrder: 0,
    description: 'quantity whose value is inversely proportional to the resistance value',
    applicableUnits: ['A2.m-2.kg-1.s3'],
  },
  'electromagnetism.ReciprocalVoltage': {
    domain,
    tensorOrder: 0,
    description: 'quantity whose value is inversely proportional to the voltage value',
    applicableUnits: ['V-1'],
  },
  'electromagnetism.RelativePermittivity': {
    domain,
    tensorOrder: 2,
    description: undefined,
    applicableUnits: ['{fraction}', '%'],
  },
  'electromagnetism.Reluctance': {
    domain,
    tensorOrder: 0,
    description:
      '"Reluctance" or magnetic resistance, is a concept used in the analysis of magnetic circuits. It is analogous to resistance in an electrical circuit, but rather than dissipating electric energy it stores magnetic energy. In likeness to the way an electric field causes an electric current to follow the path of least resistance, a magnetic field causes magnetic flux to follow the path of least magnetic reluctance. It is a scalar, extensive quantity, akin to electrical resistance.',
    applicableUnits: ['H-1'],
  },
  'electromagnetism.ResidualResistivity': {
    domain,
    tensorOrder: 2,
    description:
      '"Residual Resistivity" for metals, is the resistivity extrapolated to zero thermodynamic temperature.',
    applicableUnits: ['MOhm.km', 'Ohm.km', 'Ohm.m'],
  },
  'electromagnetism.Resistance': {
    domain,
    tensorOrder: 0,
    description:
      'The electrical resistance of an object is a measure of its opposition to the passage of a steady electric current.',
    applicableUnits: ['GOhm', 'kOhm', 'MOhm', 'uOhm', 'mOhm', 'Ohm', 'nOhm', 'TOhm'],
  },
  'electromagnetism.ResistanceBasedInductance': {
    domain,
    tensorOrder: 0,
    description:
      'magnetic flux through the loop, caused by an electric current in the loop, divided by the product of this current and the resistance which prevents the flow of current',
    applicableUnits: ['s'],
  },
  'electromagnetism.ResistanceRatio': { domain, tensorOrder: 0, description: undefined, applicableUnits: ['%'] },
  'electromagnetism.Resistivity': {
    domain,
    tensorOrder: 2,
    description: '"Resistivity" is the inverse of the conductivity when this inverse exists.',
    applicableUnits: [
      'GOhm.m',
      'kOhm.m',
      'MOhm.km',
      'MOhm.m',
      'uOhm.m',
      'mOhm.m',
      'nOhm.m',
      'Ohm.cm',
      'Ohm.[ft_i]',
      'Ohm.km',
      'Ohm.m',
      'Ohm.m2.m-1',
      'Ohm.[cml_i].[ft_i]-1',
    ],
  },
  'electromagnetism.RF-Power': {
    domain,
    tensorOrder: 0,
    description:
      'Radio-Frequency Power. Power level of electromagnetic waves alternating at the frequency of radio waves (up to 10^10 Hz).',
    applicableUnits: ['A-1.m.kg.s-3'],
  },
  'electromagnetism.RFPower': {
    domain,
    tensorOrder: 0,
    description:
      'Radio-Frequency Power. Power level of electromagnetic waves alternating at the frequency of radio waves (up to 10^10 Hz).',
    applicableUnits: ['kV.m-1', 'MV.m-1', 'uV.m-1', 'mV.m-1', 'V.cm-1', 'V.[in_i]-1', 'V.m-1', 'V.mm-1', '10.nV.cm-1'],
  },
  'electromagnetism.RiseOfOffStateVoltage': {
    domain,
    tensorOrder: 0,
    description: 'du/dt as time dependent change in voltage',
    applicableUnits: ['A-1.m2.kg.s-4'],
  },
  'electromagnetism.ScalarMagneticPotential': {
    domain,
    tensorOrder: 0,
    description:
      '"Scalar Magnetic Potential" is the scalar potential of an irrotational magnetic field strength. The negative of the gradient of the scalar magnetic potential is the irrotational magnetic field strength. The magnetic scalar potential is not unique since any constant scalar field can be added to it without changing its gradient.',
    applicableUnits: ['V.s.m-1'],
  },
  'electromagnetism.SourceVoltage': {
    domain,
    tensorOrder: 0,
    description:
      'The quantity kind $\\textit{Source Voltage}$, also referred to as $\\textit{Source Tension}$ is the voltage between the two terminals of a voltage source when there is no electric current through the source. The name $\\text{electromotive force}$ with the abbreviation $\\textit{EMF}$ and the symbol $E$ is deprecated.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.SpecificElectricCharge': {
    domain,
    tensorOrder: 0,
    description:
      'Electric charge (often capacity in the context of electrochemical cells) relativ to the mass (often only active components). capacity',
    applicableUnits: ['mA.h.g-1'],
  },
  'electromagnetism.SpecificElectricCurrent': {
    domain,
    tensorOrder: 0,
    description:
      '"Specific Electric Current" is a measure to specify the applied current relative to a corresponding mass. This measure is often used for standardization within electrochemistry.',
    applicableUnits: ['A.g-1'],
  },
  'electromagnetism.StateOfCharge': {
    domain,
    tensorOrder: 0,
    description:
      '"State of Charge",quantifies the remaining capacity available in a battery at a given time and in relation to a given state of ageing.',
    applicableUnits: ['{fraction}', '%'],
  },
  'electromagnetism.SurgeImpedanceOfTheMedium': {
    domain,
    tensorOrder: 0,
    description:
      'in a mechanical system the area-related quotient of a force affecting to a point divided by the resulting component of the particle velocity in direction of the force',
    applicableUnits: ['m-2.kg.s-1'],
  },
  'electromagnetism.Susceptance': {
    domain,
    tensorOrder: 0,
    description:
      '"Susceptance" is the imaginary part of admittance. The inverse of admittance is impedance and the real part of admittance is conductance.',
    applicableUnits: ['A2.m-2.kg-1.s3'],
  },
  'electromagnetism.TimeConstant_Inductance': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['s'],
  },
  'electromagnetism.TotalCurrent': {
    domain,
    tensorOrder: 0,
    description:
      '"Total Current" is the sum of the electric current that is flowing through a surface and the displacement current.',
    applicableUnits: ['A', 'Bi', 'aA', 'fA', 'GA', 'kA', 'MA', 'uA', 'mA', 'nA', 'PA', 'pA', 'TA'],
  },
  'electromagnetism.TotalCurrentDensity': {
    domain,
    tensorOrder: 1,
    description:
      '"Total Current Density" is the sum of the electric current density and the displacement current density.',
    applicableUnits: ['A.m-2'],
  },
  'electromagnetism.Turns': {
    domain,
    tensorOrder: 0,
    description: '"Turns" is the number of turns in a winding.',
    applicableUnits: ['{#}'],
  },
  'electromagnetism.Voltage': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Voltage}$, also referred to as $\\textit{Electric Tension}$, is the difference between electrical potentials of two points. For an electric field within a medium, $U_{ab} = - \\int_{r_a}^{r_b} E . {dr}$, where $E$ is electric field strength. For an irrotational electric field, the voltage is independent of the path between the two points $a$ and $b$.',
    applicableUnits: ['EV', 'fV', 'GV', 'kV', 'MV', 'uV', 'mV', 'nV', 'PV', 'pV', 'TV', 'V', '10.nV'],
  },
  'electromagnetism.VoltageImbalance': {
    domain,
    tensorOrder: 0,
    description:
      'Voltage imbalance is the percentage deviation of individual phase voltages from the average voltage across phases in a polyphase electrical system.',
    applicableUnits: ['{fraction}', '%'],
  },
  'electromagnetism.VoltagePhasor': {
    domain,
    tensorOrder: 0,
    description:
      '"Voltage Phasor" is a representation of voltage as a sinusoidal integral quantity using a complex quantity whose argument is equal to the initial phase and whose modulus is equal to the root-mean-square value. A phasor is a constant complex number, usually expressed in exponential form, representing the complex amplitude (magnitude and phase) of a sinusoidal function of time. Phasors are used by electrical engineers to simplify computations involving sinusoids, where they can often reduce a differential equation problem to an algebraic one.',
    applicableUnits: ['A-1.m2.kg.s-3'],
  },
  'electromagnetism.VoltageRatio': { domain, tensorOrder: 0, description: undefined, applicableUnits: ['%'] },
  'electromagnetism.VolumeDensityOfCharge': {
    domain,
    tensorOrder: 0,
    description: 'volume density of the electric charge Q present in a volume V',
    applicableUnits: ['A.m-3.s'],
  },
  'electromagnetism.VolumetricElectricCharge': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['A.m-3.s'],
  },
  'electromagnetism.VolumicElectromagneticEnergy': {
    domain,
    tensorOrder: 0,
    description:
      '$\\textit{Volumic Electromagnetic Energy}$, also known as the $\\textit{Electromagnetic Energy Density}$, is the energy associated with an electromagnetic field, per unit volume of the field.',
    applicableUnits: ['J.m-3'],
  },
} as const
