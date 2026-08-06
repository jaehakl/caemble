# Material Parameter Catalog v0.0.0

- Catalog ID: `material-parameter-catalog`
- QuantityKind data version: `0.0.0`
- Total canonical property keys: **258**

## Rules

- **canonical_key**: domain.property; do not encode direction, component, temperature, pressure, frequency, wavelength, species, phase, or model branch in the key
- **value_shape**: A property is one physical quantity value with no axes; its exact Cartesian component shape is determined only by the referenced QuantityKind tensorOrder.
- **model_parameters**: Dependencies and constitutive relations must use a key enumerated in the separate Material model catalog; arbitrary model.* keys are forbidden.
- **interface_properties**: interface.* records belong to a material/phase pair, not to one bulk material.
- **quantity_kind**: reference the single canonical QuantityKind name; domain prefixes identify physical meaning, not the catalog property's usage domain.

## Global qualifiers

- `temperature`
- `pressure`
- `frequency`
- `wavelength`
- `phase`
- `composition`
- `material_state`
- `source`
- `measurement_or_derivation_method`

## Canonical keys

### general (14)

| Key                               | Korean label         | QuantityKind                               | Special qualifiers     |
| --------------------------------- | -------------------- | ------------------------------------------ | ---------------------- |
| `general.mass_density`            | 질량 밀도            | `MassDensity`                              |                        |
| `general.specific_volume`         | 비체적               | `SpecificVolume`                           |                        |
| `general.molar_mass`              | 몰 질량              | `chemistry.MolarMass`                      | `species_or_mixture`   |
| `general.porosity`                | 공극률               | `DimensionlessRatio`                       |                        |
| `general.mass_fraction`           | 질량분율             | `MassFraction`                             | `constituent`          |
| `general.mole_fraction`           | 몰분율               | `chemistry.MoleFraction`                   | `constituent`          |
| `general.volume_fraction`         | 체적분율             | `DimensionlessRatio`                       | `constituent_or_phase` |
| `general.number_density`          | 수 밀도              | `NumberDensity`                            | `entity`               |
| `general.molar_concentration`     | 몰 농도              | `chemistry.AmountOfSubstanceConcentration` | `species`              |
| `general.mass_concentration`      | 질량 농도            | `chemistry.MassConcentration`              | `species`              |
| `general.specific_surface_area`   | 비표면적             | `SpecificSurfaceArea`                      |                        |
| `general.moisture_mass_fraction`  | 수분 질량분율        | `MassFractionOfWater`                      | `moisture_definition`  |
| `general.water_to_dry_mass_ratio` | 건조질량 기준 함수비 | `MassRatioOfWaterToDryMatter`              | `moisture_definition`  |
| `general.packing_fraction`        | 충진율               | `materials.PackingFraction`                |                        |

### mechanical (35)

| Key                                       | Korean label           | QuantityKind                        | Special qualifiers                                              |
| ----------------------------------------- | ---------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `mechanical.young_modulus`                | 영률                   | `mechanics.ModulusOfElasticity`     | `direction`, `coordinate_frame`                                 |
| `mechanical.poisson_ratio`                | 푸아송비               | `mechanics.PoissonRatio`            | `loading_direction`, `transverse_direction`, `coordinate_frame` |
| `mechanical.shear_modulus`                | 전단 탄성률            | `mechanics.ShearModulus`            | `shear_plane`, `coordinate_frame`                               |
| `mechanical.bulk_modulus`                 | 체적 탄성률            | `mechanics.BulkModulus`             |                                                                 |
| `mechanical.compressibility`              | 압축률                 | `fluidDynamics.Compressibility`     |                                                                 |
| `mechanical.lame_first_parameter`         | 라메 제1상수           | `mechanics.Stress`                  | `coordinate_frame`                                              |
| `mechanical.elastic_stiffness_tensor`     | 탄성 강성 텐서         | `mechanics.ElasticStiffnessTensor`  | `coordinate_frame`, `tensor_convention`                         |
| `mechanical.elastic_compliance_tensor`    | 탄성 컴플라이언스 텐서 | `mechanics.ElasticComplianceTensor` | `coordinate_frame`, `tensor_convention`                         |
| `mechanical.yield_strength`               | 항복강도               | `mechanics.Stress`                  | `loading_mode`, `yield_definition`, `strain_rate`               |
| `mechanical.tensile_strength`             | 인장강도               | `mechanics.Stress`                  | `test_method`, `strain_rate`                                    |
| `mechanical.compressive_strength`         | 압축강도               | `mechanics.Stress`                  | `test_method`, `strain_rate`                                    |
| `mechanical.shear_strength`               | 전단강도               | `mechanics.ShearStress`             | `test_method`, `shear_plane`                                    |
| `mechanical.flexural_strength`            | 굽힘강도               | `mechanics.Stress`                  | `test_method`                                                   |
| `mechanical.fatigue_strength`             | 피로강도               | `mechanics.Stress`                  | `cycle_count`, `stress_ratio`, `loading_mode`                   |
| `mechanical.endurance_limit`              | 피로한도               | `mechanics.Stress`                  | `stress_ratio`, `loading_mode`                                  |
| `mechanical.hardness`                     | 경도                   | `Pressure`                          | `hardness_scale`, `test_method`                                 |
| `mechanical.tangent_modulus`              | 접선 탄성률            | `mechanics.ModulusOfElasticity`     | `strain`, `loading_path`                                        |
| `mechanical.hardening_modulus`            | 경화계수               | `mechanics.ModulusOfElasticity`     | `hardening_definition`                                          |
| `mechanical.strength_coefficient`         | 강도계수               | `mechanics.Stress`                  | `constitutive_relation`                                         |
| `mechanical.strain_hardening_exponent`    | 가공경화 지수          | `Dimensionless`                     | `constitutive_relation`                                         |
| `mechanical.plastic_strain_ratio`         | 소성변형비             | `DimensionlessRatio`                | `direction`, `test_method`                                      |
| `mechanical.elongation_at_break`          | 파단 연신율            | `mechanics.Strain`                  | `gauge_length`, `test_method`                                   |
| `mechanical.fracture_strain`              | 파단 변형률            | `mechanics.Strain`                  | `stress_state`, `loading_mode`                                  |
| `mechanical.reduction_of_area`            | 단면 수축률            | `DimensionlessRatio`                | `test_method`                                                   |
| `mechanical.fracture_toughness`           | 파괴인성               | `mechanics.StressIntensityFactor`   | `fracture_mode`, `plane_condition`, `crack_orientation`         |
| `mechanical.critical_energy_release_rate` | 임계 에너지 방출률     | `mechanics.StrainEnergyReleaseRate` | `fracture_mode`, `crack_orientation`                            |
| `mechanical.fracture_energy`              | 파괴에너지             | `EnergyPerArea`                     | `fracture_mode`, `test_method`                                  |
| `mechanical.relaxation_modulus`           | 완화 탄성률            | `mechanics.ModulusOfElasticity`     | `time_or_frequency`, `loading_mode`                             |
| `mechanical.creep_compliance`             | 크리프 컴플라이언스    | `InversePressure`                   | `time`, `loading_mode`                                          |
| `mechanical.relaxation_time`              | 완화시간               | `RelaxationTime`                    | `mode_or_branch_index`                                          |
| `mechanical.storage_modulus`              | 저장 탄성률            | `mechanics.ModulusOfElasticity`     | `frequency`, `loading_mode`                                     |
| `mechanical.loss_modulus`                 | 손실 탄성률            | `mechanics.ModulusOfElasticity`     | `frequency`, `loading_mode`                                     |
| `mechanical.loss_factor`                  | 기계 손실계수          | `LossFactor`                        | `frequency`, `loading_mode`                                     |
| `mechanical.damping_ratio`                | 감쇠비                 | `DimensionlessRatio`                | `mode`, `frequency`                                             |
| `mechanical.quality_factor`               | 기계 품질계수          | `QualityFactor`                     | `mode`, `frequency`                                             |

### thermal (20)

| Key                                        | Korean label | QuantityKind                                            | Special qualifiers            |
| ------------------------------------------ | ------------ | ------------------------------------------------------- | ----------------------------- |
| `thermal.conductivity`                     | 열전도율     | `thermodynamics.ThermalConductivity`                    | `coordinate_frame`            |
| `thermal.diffusivity`                      | 열확산도     | `thermodynamics.ThermalDiffusivity`                     | `coordinate_frame`            |
| `thermal.specific_heat_capacity`           | 비열         | `thermodynamics.SpecificHeatCapacity`                   |                               |
| `thermal.specific_heat_capacity_cp`        | 정압 비열    | `thermodynamics.SpecificHeatCapacityAtConstantPressure` |                               |
| `thermal.specific_heat_capacity_cv`        | 정적 비열    | `thermodynamics.SpecificHeatCapacityAtConstantVolume`   |                               |
| `thermal.volumetric_heat_capacity`         | 체적 열용량  | `thermodynamics.VolumetricHeatCapacity`                 |                               |
| `thermal.heat_capacity_ratio`              | 비열비       | `thermodynamics.HeatCapacityRatio`                      |                               |
| `thermal.linear_expansion_coefficient`     | 선팽창계수   | `thermodynamics.ThermalExpansionCoefficient`            | `coordinate_frame`            |
| `thermal.volumetric_expansion_coefficient` | 체적팽창계수 | `thermodynamics.CubicExpansionCoefficient`              |                               |
| `thermal.resistivity`                      | 열저항률     | `thermodynamics.ThermalResistivity`                     |                               |
| `thermal.inertia`                          | 열관성       | `thermodynamics.ThermalInertia`                         |                               |
| `thermal.melting_temperature`              | 융점         | `thermodynamics.MeltingPoint`                           |                               |
| `thermal.boiling_temperature`              | 비점         | `thermodynamics.BoilingPoint`                           | `ambient_pressure`            |
| `thermal.glass_transition_temperature`     | 유리전이온도 | `thermodynamics.ThermodynamicTemperature`               | `measurement_method`          |
| `thermal.solidus_temperature`              | 고상선 온도  | `thermodynamics.ThermodynamicTemperature`               | `composition`                 |
| `thermal.liquidus_temperature`             | 액상선 온도  | `thermodynamics.ThermodynamicTemperature`               | `composition`                 |
| `thermal.decomposition_temperature`        | 분해온도     | `thermodynamics.ThermodynamicTemperature`               | `environment`, `heating_rate` |
| `thermal.latent_heat_fusion`               | 융해 잠열    | `SpecificEnergy`                                        |                               |
| `thermal.latent_heat_vaporization`         | 기화 잠열    | `SpecificEnergy`                                        | `pressure`                    |
| `thermal.thermal_insulance`                | 열관류 저항  | `thermodynamics.ThermalInsulance`                       | `thickness`                   |

### thermodynamic (16)

| Key                                       | Korean label     | QuantityKind                              | Special qualifiers               |
| ----------------------------------------- | ---------------- | ----------------------------------------- | -------------------------------- |
| `thermodynamic.vapor_pressure`            | 증기압           | `thermodynamics.VapourPressure`           | `species_or_mixture`             |
| `thermodynamic.compressibility_factor`    | 압축성 계수      | `thermodynamics.CompressibilityFactor`    | `mixture`                        |
| `thermodynamic.critical_temperature`      | 임계온도         | `thermodynamics.ThermodynamicTemperature` | `species_or_mixture`             |
| `thermodynamic.critical_pressure`         | 임계압력         | `Pressure`                                | `species_or_mixture`             |
| `thermodynamic.triple_point_temperature`  | 삼중점 온도      | `thermodynamics.ThermodynamicTemperature` | `species`                        |
| `thermodynamic.specific_enthalpy`         | 비엔탈피         | `thermodynamics.SpecificEnthalpy`         |                                  |
| `thermodynamic.specific_internal_energy`  | 비내부에너지     | `thermodynamics.SpecificInternalEnergy`   |                                  |
| `thermodynamic.specific_entropy`          | 비엔트로피       | `thermodynamics.SpecificEntropy`          |                                  |
| `thermodynamic.specific_gibbs_energy`     | 비깁스에너지     | `thermodynamics.SpecificGibbsEnergy`      |                                  |
| `thermodynamic.specific_helmholtz_energy` | 비헬름홀츠에너지 | `thermodynamics.SpecificHelmholtzEnergy`  |                                  |
| `thermodynamic.chemical_potential`        | 화학 퍼텐셜      | `chemistry.ChemicalPotential`             | `species`                        |
| `thermodynamic.activity_coefficient`      | 활동도 계수      | `chemistry.ActivityCoefficient`           | `species`, `mixture_composition` |
| `thermodynamic.fugacity`                  | 퓨가시티         | `chemistry.Fugacity`                      | `species`, `mixture_composition` |
| `thermodynamic.equilibrium_constant`      | 평형상수         | `chemistry.EquilibriumConstant`           | `reaction`, `standard_state`     |
| `thermodynamic.osmotic_coefficient`       | 삼투계수         | `chemistry.OsmoticCoefficient`            | `mixture_composition`            |
| `thermodynamic.osmotic_pressure`          | 삼투압           | `chemistry.OsmoticPressure`               | `mixture_composition`            |

### fluid (8)

| Key                                | Korean label        | QuantityKind                              | Special qualifiers |
| ---------------------------------- | ------------------- | ----------------------------------------- | ------------------ |
| `fluid.dynamic_viscosity`          | 동적 점도(점성계수) | `fluidDynamics.DynamicViscosity`          |                    |
| `fluid.kinematic_viscosity`        | 동점도              | `fluidDynamics.KinematicViscosity`        |                    |
| `fluid.bulk_viscosity`             | 체적점도            | `fluidDynamics.DynamicViscosity`          | `definition`       |
| `fluid.fluidity`                   | 유동도              | `fluidDynamics.Fluidity`                  |                    |
| `fluid.isothermal_compressibility` | 등온 압축률         | `fluidDynamics.IsothermalCompressibility` |                    |
| `fluid.isentropic_compressibility` | 등엔트로피 압축률   | `fluidDynamics.IsentropicCompressibility` |                    |
| `fluid.speed_of_sound`             | 음속                | `acoustics.SpeedOfSound`                  | `wave_mode`        |
| `fluid.yield_stress`               | 유변학적 항복응력   | `mechanics.Stress`                        | `rheology_model`   |

### transport (18)

| Key                                           | Korean label    | QuantityKind                                | Special qualifiers                     |
| --------------------------------------------- | --------------- | ------------------------------------------- | -------------------------------------- |
| `transport.diffusion_coefficient`             | 확산계수        | `transport.DiffusionCoefficient`            | `species`, `phase`, `coordinate_frame` |
| `transport.binary_diffusion_coefficient`      | 이성분 확산계수 | `transport.DiffusionCoefficient`            | `species_pair`, `phase`                |
| `transport.moisture_diffusivity`              | 수분 확산도     | `transport.DiffusionCoefficient`            | `moisture_definition`                  |
| `transport.water_vapor_diffusion_coefficient` | 수증기 확산계수 | `transport.WaterVapourDiffusionCoefficient` | `gas_mixture`                          |
| `transport.thermal_diffusion_factor`          | 열확산 인자     | `transport.ThermalDiffusionFactor`          | `species_pair`                         |
| `transport.intrinsic_permeability`            | 고유투수율      | `transport.HydraulicPermeability`           | `coordinate_frame`                     |
| `transport.relative_permeability`             | 상대투수율      | `transport.PermeabilityRatio`               | `phase`, `saturation_definition`       |
| `transport.vapor_permeability`                | 수증기 투과율   | `transport.VapourPermeability`              | `species`, `driving_force_definition`  |
| `transport.vapor_permeance`                   | 수증기 투과도   | `transport.VapourPermeance`                 | `thickness`                            |
| `transport.tortuosity`                        | 굴곡도          | `DimensionlessRatio`                        | `transport_mode`, `coordinate_frame`   |
| `transport.longitudinal_dispersivity`         | 종방향 분산도   | `Length`                                    | `flow_direction`                       |
| `transport.transverse_dispersivity`           | 횡방향 분산도   | `Length`                                    | `flow_direction`                       |
| `transport.solubility`                        | 용해도          | `chemistry.AmountOfSubstanceConcentration`  | `solute`, `solvent`                    |
| `transport.henry_constant`                    | 헨리 상수       | `chemistry.HenrysLawVolatilityConstant`     | `solute`, `solvent`, `definition`      |
| `transport.partition_coefficient`             | 분배계수        | `DimensionlessRatio`                        | `species`, `phase_pair`, `definition`  |
| `transport.adsorption_coefficient`            | 흡착계수        | `chemistry.SoilAdsorptionCoefficient`       | `species`, `sorbent`, `definition`     |
| `transport.capillary_pressure`                | 모세관압        | `Pressure`                                  | `phase_pair`, `saturation_definition`  |
| `transport.mobility`                          | 이동도          | `transport.Mobility`                        | `carrier_or_species`, `driving_field`  |

### electrical (15)

| Key                                     | Korean label       | QuantityKind                              | Special qualifiers                     |
| --------------------------------------- | ------------------ | ----------------------------------------- | -------------------------------------- |
| `electrical.conductivity`               | 전기전도도         | `electromagnetism.ElectricConductivity`   | `frequency`, `coordinate_frame`        |
| `electrical.resistivity`                | 비저항             | `electromagnetism.Resistivity`            | `frequency`, `coordinate_frame`        |
| `electrical.permittivity`               | 유전율             | `electromagnetism.Permittivity`           | `frequency`, `coordinate_frame`        |
| `electrical.relative_permittivity`      | 상대유전율         | `electromagnetism.RelativePermittivity`   | `frequency`, `coordinate_frame`        |
| `electrical.susceptibility`             | 전기 감수율        | `electromagnetism.ElectricSusceptibility` | `frequency`, `coordinate_frame`        |
| `electrical.dielectric_strength`        | 절연 파괴 전계강도 | `electromagnetism.ElectricFieldStrength`  | `test_method`, `waveform`, `thickness` |
| `electrical.loss_tangent`               | 유전 손실탄젠트    | `LossFactor`                              | `frequency`, `field_direction`         |
| `electrical.loss_angle`                 | 유전 손실각        | `electromagnetism.LossAngle`              | `frequency`, `field_direction`         |
| `electrical.polarization`               | 전기 분극          | `electromagnetism.ElectricPolarization`   | `electric_field`, `coordinate_frame`   |
| `electrical.work_function`              | 일함수             | `materials.WorkFunction`                  | `surface_orientation`                  |
| `electrical.hall_coefficient`           | 홀 계수            | `electromagnetism.HallCoefficient`        | `carrier_type`, `field_direction`      |
| `electrical.seebeck_coefficient`        | 제벡 계수          | `coupledPhenomena.SeebeckCoefficient`     | `coordinate_frame`                     |
| `electrical.peltier_coefficient`        | 펠티에 계수        | `coupledPhenomena.PeltierCoefficient`     | `junction_pair`, `coordinate_frame`    |
| `electrical.surface_resistance`         | 표면저항           | `electromagnetism.Resistance`             | `electrode_geometry`                   |
| `electrical.dielectric_relaxation_time` | 유전 완화시간      | `RelaxationTime`                          | `mode_or_branch_index`                 |

### magnetic (16)

| Key                                               | Korean label              | QuantityKind                                        | Special qualifiers                     |
| ------------------------------------------------- | ------------------------- | --------------------------------------------------- | -------------------------------------- |
| `magnetic.permeability`                           | 투자율                    | `electromagnetism.ElectromagneticPermeability`      | `frequency`, `coordinate_frame`        |
| `magnetic.relative_permeability`                  | 상대투자율                | `electromagnetism.ElectromagneticPermeabilityRatio` | `frequency`, `coordinate_frame`        |
| `magnetic.susceptibility`                         | 자기 감수율               | `electromagnetism.MagneticSusceptability`           | `coordinate_frame`                     |
| `magnetic.coercivity`                             | 보자력                    | `electromagnetism.Coercivity`                       | `hysteresis_branch`, `field_direction` |
| `magnetic.remanent_flux_density`                  | 잔류 자속밀도             | `electromagnetism.MagneticFluxDensity`              | `field_direction`                      |
| `magnetic.saturation_flux_density`                | 포화 자속밀도             | `electromagnetism.MagneticFluxDensity`              | `field_direction`                      |
| `magnetic.remanent_magnetization`                 | 잔류 자화                 | `electromagnetism.Magnetization`                    | `field_direction`                      |
| `magnetic.saturation_magnetization`               | 포화 자화                 | `electromagnetism.Magnetization`                    | `field_direction`                      |
| `magnetic.curie_temperature`                      | 퀴리 온도                 | `materials.CurieTemperature`                        |                                        |
| `magnetic.neel_temperature`                       | 닐 온도                   | `materials.NeelTemperature`                         |                                        |
| `magnetic.lower_critical_flux_density`            | 하부 임계 자속밀도        | `materials.LowerCriticalMagneticFluxDensity`        |                                        |
| `magnetic.upper_critical_flux_density`            | 상부 임계 자속밀도        | `materials.UpperCriticalMagneticFluxDensity`        |                                        |
| `magnetic.superconducting_transition_temperature` | 초전도 전이온도           | `materials.SuperconductionTransitionTemperature`    |                                        |
| `magnetic.london_penetration_depth`               | 런던 침투깊이             | `materials.LondonPenetrationDepth`                  |                                        |
| `magnetic.coherence_length`                       | 결맞음 길이               | `materials.CoherenceLength`                         |                                        |
| `magnetic.hysteresis_loss_density`                | 자기 이력 손실 에너지밀도 | `EnergyDensity`                                     | `cycle`, `frequency`                   |

### optical (13)

| Key                                    | Korean label  | QuantityKind                          | Special qualifiers                                                        |
| -------------------------------------- | ------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `optical.refractive_index`             | 굴절률        | `optics.RefractiveIndex`              | `wavelength_or_frequency`, `polarization`, `coordinate_frame`             |
| `optical.extinction_coefficient`       | 소광계수      | `Dimensionless`                       | `wavelength_or_frequency`, `polarization`                                 |
| `optical.absorption_coefficient`       | 광 흡수계수   | `optics.LinearAbsorptionCoefficient`  | `wavelength_or_frequency`, `polarization`                                 |
| `optical.attenuation_coefficient`      | 광 감쇠계수   | `AttenuationCoefficient`              | `wavelength_or_frequency`, `polarization`                                 |
| `optical.scattering_coefficient`       | 광 산란계수   | `InverseLength`                       | `wavelength_or_frequency`, `scattering_definition`                        |
| `optical.molar_absorption_coefficient` | 몰 흡광계수   | `optics.MolarAbsorptionCoefficient`   | `species`, `wavelength_or_frequency`                                      |
| `optical.reflectance`                  | 반사율        | `optics.Reflectance`                  | `wavelength_or_frequency`, `incidence_angle`, `polarization`              |
| `optical.transmittance`                | 투과율        | `optics.Transmittance`                | `wavelength_or_frequency`, `thickness`, `incidence_angle`, `polarization` |
| `optical.absorptance`                  | 흡수율        | `Absorptance`                         | `wavelength_or_frequency`, `incidence_angle`, `polarization`              |
| `optical.abbe_number`                  | 아베수        | `optics.Constringence`                | `spectral_definition`                                                     |
| `optical.phase_coefficient`            | 위상계수      | `optics.PhaseCoefficient`             | `frequency`, `propagation_direction`                                      |
| `optical.specific_rotatory_power`      | 비선광도      | `optics.SpecificOpticalRotatoryPower` | `wavelength`, `path_direction`                                            |
| `optical.nonlinear_refractive_index`   | 비선형 굴절률 | `optics.AreaPerPower`                 | `wavelength_or_frequency`, `polarization`                                 |

### radiative (2)

| Key                      | Korean label | QuantityKind          | Special qualifiers                                           |
| ------------------------ | ------------ | --------------------- | ------------------------------------------------------------ |
| `radiative.emissivity`   | 방사율       | `optics.Emissivity`   | `wavelength_or_band`, `direction`                            |
| `radiative.reflectivity` | 고유 반사율  | `optics.Reflectivity` | `wavelength_or_frequency`, `incidence_angle`, `polarization` |

### acoustic (6)

| Key                                 | Korean label       | QuantityKind                                | Special qualifiers                   |
| ----------------------------------- | ------------------ | ------------------------------------------- | ------------------------------------ |
| `acoustic.characteristic_impedance` | 특성 음향 임피던스 | `acoustics.CharacteristicAcousticImpedance` | `frequency`, `propagation_direction` |
| `acoustic.impedance`                | 음향 임피던스      | `acoustics.AcousticImpedance`               | `frequency`, `boundary_definition`   |
| `acoustic.attenuation_coefficient`  | 음향 감쇠계수      | `AttenuationCoefficient`                    | `frequency`, `wave_mode`             |
| `acoustic.absorption_coefficient`   | 흡음률             | `Absorptance`                               | `frequency`, `incidence_angle`       |
| `acoustic.loss_factor`              | 음향 손실계수      | `LossFactor`                                | `frequency`, `wave_mode`             |
| `acoustic.flow_resistivity`         | 유동저항률         | `acoustics.FlowResistivity`                 | `flow_direction`                     |

### chemical (13)

| Key                                           | Korean label         | QuantityKind                                | Special qualifiers                   |
| --------------------------------------------- | -------------------- | ------------------------------------------- | ------------------------------------ |
| `chemical.ph`                                 | pH                   | `chemistry.Acidity`                         | `solvent`, `measurement_scale`       |
| `chemical.ionic_strength`                     | 이온강도             | `chemistry.IonicStrength`                   | `solution`                           |
| `chemical.first_order_rate_constant`          | 1차 반응속도상수     | `InverseTime`                               | `reaction`                           |
| `chemical.second_order_rate_constant`         | 2차 반응속도상수     | `chemistry.SecondOrderReactionRateConstant` | `reaction`                           |
| `chemical.activation_energy`                  | 활성화에너지         | `chemistry.MolarEnergy`                     | `reaction`                           |
| `chemical.heat_of_reaction`                   | 반응열               | `chemistry.MolarEnergy`                     | `reaction`, `reference_state`        |
| `chemical.standard_enthalpy_of_formation`     | 표준 생성 엔탈피     | `chemistry.MolarEnergy`                     | `species`, `reference_state`         |
| `chemical.standard_gibbs_energy_of_formation` | 표준 생성 깁스에너지 | `chemistry.MolarEnergy`                     | `species`, `reference_state`         |
| `chemical.standard_molar_entropy`             | 표준 몰 엔트로피     | `chemistry.MolarEntropy`                    | `species`, `reference_state`         |
| `chemical.heating_value`                      | 발열량               | `thermodynamics.HeatingValue`               | `higher_or_lower`, `reference_state` |
| `chemical.flash_point`                        | 인화점               | `chemistry.FlashPoint`                      | `test_method`                        |
| `chemical.autoignition_temperature`           | 자연발화온도         | `thermodynamics.ThermodynamicTemperature`   | `test_method`, `environment`         |
| `chemical.catalytic_activity`                 | 촉매 활성            | `chemistry.CatalyticActivity`               | `reaction`, `catalyst_state`         |

### combustion (3)

| Key                                   | Korean label  | QuantityKind         | Special qualifiers             |
| ------------------------------------- | ------------- | -------------------- | ------------------------------ |
| `combustion.laminar_flame_speed`      | 층류 화염속도 | `kinematics.Speed`   | `mixture`, `equivalence_ratio` |
| `combustion.lower_flammability_limit` | 하한 가연한계 | `DimensionlessRatio` | `fuel`, `oxidizer`, `basis`    |
| `combustion.upper_flammability_limit` | 상한 가연한계 | `DimensionlessRatio` | `fuel`, `oxidizer`, `basis`    |

### electrochemical (14)

| Key                                                 | Korean label           | QuantityKind                                       | Special qualifiers                                   |
| --------------------------------------------------- | ---------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `electrochemical.ionic_conductivity`                | 이온전도도             | `chemistry.ElectrolyticConductivity`               | `mobile_ion`, `coordinate_frame`                     |
| `electrochemical.molar_conductivity`                | 몰 전도도              | `chemistry.MolarConductivity`                      | `electrolyte`                                        |
| `electrochemical.ion_diffusion_coefficient`         | 이온 확산계수          | `transport.DiffusionCoefficient`                   | `ion`, `host_phase`, `coordinate_frame`              |
| `electrochemical.transport_number`                  | 이온 수송수            | `chemistry.IonTransportNumber`                     | `ion`                                                |
| `electrochemical.open_circuit_potential`            | 개방회로전위           | `electromagnetism.ElectricPotential`               | `electrode`, `reference_electrode`, `state_variable` |
| `electrochemical.equilibrium_potential`             | 평형전위               | `electromagnetism.ElectricPotential`               | `reaction`, `reference_electrode`                    |
| `electrochemical.exchange_current_density`          | 교환전류밀도           | `electromagnetism.ElectricCurrentDensity`          | `reaction`, `interface`                              |
| `electrochemical.double_layer_capacitance_per_area` | 면적당 이중층 정전용량 | `electromagnetism.CapacitancePerArea`              | `interface`                                          |
| `electrochemical.specific_capacity`                 | 비용량                 | `electromagnetism.SpecificElectricCharge`          | `active_material`, `charge_or_discharge`             |
| `electrochemical.volumetric_capacity`               | 체적용량               | `electromagnetism.ElectricChargeDensity`           | `active_material`, `charge_or_discharge`             |
| `electrochemical.maximum_species_concentration`     | 최대 종 농도           | `chemistry.AmountOfSubstanceConcentration`         | `species`, `host_phase`                              |
| `electrochemical.charge_transfer_coefficient`       | 전하이동계수           | `Dimensionless`                                    | `reaction`, `anodic_or_cathodic`                     |
| `electrochemical.entropic_potential_coefficient`    | 전위 엔트로피 계수     | `coupledPhenomena.ElectricPotentialPerTemperature` | `electrode`, `state_variable`                        |
| `electrochemical.active_specific_surface_area`      | 활성 비표면적          | `SpecificSurfaceArea`                              | `reaction_site`                                      |

### semiconductor (15)

| Key                                           | Korean label     | QuantityKind                         | Special qualifiers                        |
| --------------------------------------------- | ---------------- | ------------------------------------ | ----------------------------------------- |
| `semiconductor.band_gap_energy`               | 밴드갭 에너지    | `materials.GapEnergy`                | `band_transition`                         |
| `semiconductor.electron_affinity`             | 전자친화도       | `materials.ElectronAffinity`         | `surface_orientation`                     |
| `semiconductor.electron_mobility`             | 전자 이동도      | `materials.ElectronMobility`         | `field_regime`, `coordinate_frame`        |
| `semiconductor.hole_mobility`                 | 정공 이동도      | `transport.Mobility`                 | `field_regime`, `coordinate_frame`        |
| `semiconductor.electron_density`              | 전자 밀도        | `materials.ElectronDensity`          |                                           |
| `semiconductor.hole_density`                  | 정공 밀도        | `materials.HoleDensity`              |                                           |
| `semiconductor.intrinsic_carrier_density`     | 고유 캐리어 밀도 | `materials.IntrinsicCarrierDensity`  |                                           |
| `semiconductor.donor_density`                 | 도너 농도        | `materials.DonorDensity`             | `dopant`                                  |
| `semiconductor.acceptor_density`              | 억셉터 농도      | `materials.AcceptorDensity`          | `dopant`                                  |
| `semiconductor.carrier_lifetime`              | 캐리어 수명      | `materials.CarrierLifetime`          | `carrier_type`, `recombination_mechanism` |
| `semiconductor.recombination_coefficient`     | 재결합계수       | `materials.RecombinationCoefficient` | `recombination_mechanism`                 |
| `semiconductor.electron_effective_mass`       | 전자 유효질량    | `materials.EffectiveMass`            | `band`, `coordinate_frame`                |
| `semiconductor.hole_effective_mass`           | 정공 유효질량    | `materials.EffectiveMass`            | `band`, `coordinate_frame`                |
| `semiconductor.saturation_velocity`           | 캐리어 포화속도  | `kinematics.Speed`                   | `carrier_type`, `field_direction`         |
| `semiconductor.impact_ionization_coefficient` | 충돌 이온화계수  | `InverseLength`                      | `carrier_type`, `field_direction`         |

### radiation (16)

| Key                                          | Korean label         | QuantityKind                                  | Special qualifiers                                          |
| -------------------------------------------- | -------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `radiation.linear_attenuation_coefficient`   | 선형 감쇠계수        | `atomicNuclear.LinearAttenuationCoefficient`  | `particle_or_photon`, `energy`                              |
| `radiation.mass_attenuation_coefficient`     | 질량 감쇠계수        | `atomicNuclear.MassAttenuationCoefficient`    | `particle_or_photon`, `energy`                              |
| `radiation.mass_absorption_coefficient`      | 질량 흡수계수        | `atomicNuclear.MassAbsorptionCoefficient`     | `particle_or_photon`, `energy`                              |
| `radiation.molar_attenuation_coefficient`    | 몰 감쇠계수          | `atomicNuclear.MolarAttenuationCoefficient`   | `particle_or_photon`, `energy`                              |
| `radiation.microscopic_cross_section`        | 미시적 단면적        | `atomicNuclear.CrossSection`                  | `incident_particle`, `target_nuclide`, `reaction`, `energy` |
| `radiation.macroscopic_cross_section`        | 거시적 단면적        | `atomicNuclear.MacroscopicCrossSection`       | `incident_particle`, `reaction`, `energy`                   |
| `radiation.total_cross_section`              | 총 단면적            | `atomicNuclear.TotalCrossSection`             | `incident_particle`, `target_nuclide`, `energy`             |
| `radiation.linear_stopping_power`            | 선형 저지능          | `atomicNuclear.TotalLinearStoppingPower`      | `particle`, `energy`                                        |
| `radiation.mass_stopping_power`              | 질량 저지능          | `atomicNuclear.TotalMassStoppingPower`        | `particle`, `energy`                                        |
| `radiation.half_life`                        | 반감기               | `atomicNuclear.HalfLife`                      | `nuclide`, `decay_mode`                                     |
| `radiation.decay_constant`                   | 붕괴상수             | `atomicNuclear.DecayConstant`                 | `nuclide`, `decay_mode`                                     |
| `radiation.specific_activity`                | 비방사능             | `atomicNuclear.SpecificActivity`              | `nuclide`, `reference_time`                                 |
| `radiation.neutron_diffusion_coefficient`    | 중성자 확산계수      | `atomicNuclear.NeutronDiffusionCoefficient`   | `energy_group`                                              |
| `radiation.neutron_diffusion_length`         | 중성자 확산길이      | `atomicNuclear.NeutronDiffusionLength`        | `energy_group`                                              |
| `radiation.mean_free_path`                   | 평균 자유행로        | `transport.MeanFreePath`                      | `particle_or_photon`, `energy`                              |
| `radiation.mass_energy_transfer_coefficient` | 질량 에너지 전달계수 | `atomicNuclear.MassEnergyTransferCoefficient` | `photon_energy`                                             |

### microstructure (11)

| Key                                     | Korean label     | QuantityKind                    | Special qualifiers                           |
| --------------------------------------- | ---------------- | ------------------------------- | -------------------------------------------- |
| `microstructure.mean_grain_size`        | 평균 결정립 크기 | `Length`                        | `measurement_method`                         |
| `microstructure.mean_particle_size`     | 평균 입자 크기   | `Length`                        | `particle_population`, `size_definition`     |
| `microstructure.mean_pore_size`         | 평균 공극 크기   | `Length`                        | `size_definition`                            |
| `microstructure.phase_fraction`         | 상 분율          | `DimensionlessRatio`            | `phase`                                      |
| `microstructure.crystallinity_fraction` | 결정화도         | `DimensionlessRatio`            | `measurement_method`                         |
| `microstructure.dislocation_density`    | 전위 밀도        | `InverseArea`                   | `dislocation_type`                           |
| `microstructure.defect_number_density`  | 결함 수 밀도     | `NumberDensity`                 | `defect_type`                                |
| `microstructure.lattice_parameter`      | 격자상수         | `Length`                        | `crystal_axis`                               |
| `microstructure.lattice_plane_spacing`  | 격자면 간격      | `materials.LatticePlaneSpacing` | `miller_indices`                             |
| `microstructure.burgers_vector`         | 버거스 벡터      | `materials.BurgersVector`       | `dislocation_type`, `coordinate_frame`       |
| `microstructure.crystal_orientation`    | 결정방위         | `PlaneAngle`                    | `coordinate_frame`, `orientation_convention` |

### coupled (8)

| Key                                         | Korean label      | QuantityKind                                       | Special qualifiers                      |
| ------------------------------------------- | ----------------- | -------------------------------------------------- | --------------------------------------- |
| `coupled.piezoelectric_charge_coefficient`  | 압전 전하계수     | `coupledPhenomena.PiezoelectricChargeCoefficient`  | `coordinate_frame`, `tensor_convention` |
| `coupled.piezoelectric_voltage_coefficient` | 압전 전압계수     | `coupledPhenomena.PiezoelectricVoltageCoefficient` | `coordinate_frame`, `tensor_convention` |
| `coupled.piezoelectric_stress_coefficient`  | 압전 응력계수     | `coupledPhenomena.PiezoelectricStressCoefficient`  | `coordinate_frame`, `tensor_convention` |
| `coupled.pyroelectric_coefficient`          | 초전계수          | `coupledPhenomena.PyroelectricCoefficient`         | `coordinate_frame`                      |
| `coupled.piezoresistive_coefficient`        | 압저항계수        | `coupledPhenomena.PiezoresistiveCoefficient`       | `coordinate_frame`, `tensor_convention` |
| `coupled.magnetostriction`                  | 자왜율            | `DimensionlessRatio`                               | `magnetic_field`, `coordinate_frame`    |
| `coupled.electrostriction_coefficient`      | 전왜계수          | `coupledPhenomena.ElectrostrictionCoefficient`     | `coordinate_frame`, `tensor_convention` |
| `coupled.magnetoelectric_coefficient`       | 자기전기 결합계수 | `coupledPhenomena.MagnetoelectricCoefficient`      | `coordinate_frame`, `frequency`         |

### interface (15)

| Key                                             | Korean label         | QuantityKind                               | Special qualifiers                                   |
| ----------------------------------------------- | -------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `interface.static_friction_coefficient`         | 정지마찰계수         | `mechanics.StaticFrictionCoefficient`      | `material_pair`, `surface_state`                     |
| `interface.dynamic_friction_coefficient`        | 동마찰계수           | `mechanics.DynamicFrictionCoefficient`     | `material_pair`, `surface_state`, `slip_rate`        |
| `interface.contact_angle`                       | 접촉각               | `PlaneAngle`                               | `solid`, `liquid`, `gas`, `advancing_or_receding`    |
| `interface.interfacial_tension`                 | 계면장력             | `fluidDynamics.SurfaceTension`             | `phase_pair`                                         |
| `interface.interfacial_energy`                  | 계면에너지           | `EnergyPerArea`                            | `material_or_phase_pair`, `interface_orientation`    |
| `interface.adhesion_energy`                     | 접착에너지           | `EnergyPerArea`                            | `material_pair`, `surface_state`                     |
| `interface.cohesive_strength`                   | 계면 응집강도        | `mechanics.Stress`                         | `material_pair`, `loading_mode`                      |
| `interface.normal_stiffness_per_area`           | 면적당 법선 접촉강성 | `mechanics.StiffnessPerArea`               | `material_pair`                                      |
| `interface.tangential_stiffness_per_area`       | 면적당 접선 접촉강성 | `mechanics.StiffnessPerArea`               | `material_pair`, `shear_direction`                   |
| `interface.critical_normal_separation`          | 임계 법선 분리거리   | `Length`                                   | `material_pair`                                      |
| `interface.critical_tangential_separation`      | 임계 접선 분리거리   | `Length`                                   | `material_pair`, `shear_direction`                   |
| `interface.thermal_contact_conductance`         | 열접촉 컨덕턴스      | `thermodynamics.CoefficientOfHeatTransfer` | `material_pair`, `contact_pressure`, `surface_state` |
| `interface.thermal_contact_resistance_per_area` | 면적 열접촉저항      | `thermodynamics.ThermalResistancePerArea`  | `material_pair`, `contact_pressure`, `surface_state` |
| `interface.electrical_contact_resistance`       | 전기 접촉저항        | `electromagnetism.Resistance`              | `material_pair`, `contact_pressure`, `surface_state` |
| `interface.mass_transfer_coefficient`           | 계면 물질전달계수    | `kinematics.Speed`                         | `species`, `phase_pair`                              |
