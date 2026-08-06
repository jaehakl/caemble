import { defineMaterialParameterDomain } from '../types'

export const microstructureMaterialParameters = defineMaterialParameterDomain('microstructure', [
  {
    key: 'microstructure.mean_grain_size',
    label_ko: '평균 결정립 크기',
    quantity_kind: 'Length',
    special_qualifiers: ['measurement_method'],
  },
  {
    key: 'microstructure.mean_particle_size',
    label_ko: '평균 입자 크기',
    quantity_kind: 'Length',
    special_qualifiers: ['particle_population', 'size_definition'],
  },
  {
    key: 'microstructure.mean_pore_size',
    label_ko: '평균 공극 크기',
    quantity_kind: 'Length',
    special_qualifiers: ['size_definition'],
  },
  {
    key: 'microstructure.phase_fraction',
    label_ko: '상 분율',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['phase'],
  },
  {
    key: 'microstructure.crystallinity_fraction',
    label_ko: '결정화도',
    quantity_kind: 'DimensionlessRatio',
    special_qualifiers: ['measurement_method'],
  },
  {
    key: 'microstructure.dislocation_density',
    label_ko: '전위 밀도',
    quantity_kind: 'InverseArea',
    special_qualifiers: ['dislocation_type'],
  },
  {
    key: 'microstructure.defect_number_density',
    label_ko: '결함 수 밀도',
    quantity_kind: 'NumberDensity',
    special_qualifiers: ['defect_type'],
  },
  {
    key: 'microstructure.lattice_parameter',
    label_ko: '격자상수',
    quantity_kind: 'Length',
    special_qualifiers: ['crystal_axis'],
  },
  {
    key: 'microstructure.lattice_plane_spacing',
    label_ko: '격자면 간격',
    quantity_kind: 'materials.LatticePlaneSpacing',
    special_qualifiers: ['miller_indices'],
  },
  {
    key: 'microstructure.burgers_vector',
    label_ko: '버거스 벡터',
    quantity_kind: 'materials.BurgersVector',
    special_qualifiers: ['dislocation_type', 'coordinate_frame'],
  },
  {
    key: 'microstructure.crystal_orientation',
    label_ko: '결정방위',
    quantity_kind: 'PlaneAngle',
    special_qualifiers: ['coordinate_frame', 'orientation_convention'],
  },
] as const)
