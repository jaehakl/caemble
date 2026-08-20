import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type CurvedEdgeCylinderFourierMode = Readonly<{
  amplitude: number
  phase: number
}>

export type CurvedEdgeCylinderTaylorCurve = Readonly<{
  origin: number
  coefficients: readonly number[]
}>

export type CurvedEdgeCylinderAttributes = Readonly<{
  height: number
  azimuthalCurve: readonly CurvedEdgeCylinderFourierMode[]
  verticalCurve: CurvedEdgeCylinderTaylorCurve
  azimuthalSegments?: number
  verticalSegments?: number
}> &
  IntrinsicGeometryAttributes

export const curvedEdgeCylinderManifest = {
  tag: 'curvedEdgeCylinder',
  authoringName: 'CurvedEdgeCylinder',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<CurvedEdgeCylinder height={h} azimuthalCurve={modes} verticalCurve={{origin,coefficients}} />',
  summary: 'Fourier 방위 곡선과 Taylor 높이 곡선의 곱으로 반지름이 정해지는 닫힌 원기둥을 생성합니다.',
  keywords: ['curved edge cylinder', 'fourier cylinder', '곡면 원기둥', '푸리에'],
  properties: [
    { name: 'height', type: 'number', required: true, description: 'Z축 방향의 유한한 양수 전체 높이입니다.' },
    {
      name: 'azimuthalCurve',
      type: 'readonly { amplitude: number; phase: number }[]',
      required: true,
      description:
        '비어 있지 않은 Fourier mode 배열입니다. amplitude는 유한한 0 이상, phase는 유한해야 하며 모든 표본 반지름은 양수여야 합니다.',
    },
    {
      name: 'verticalCurve',
      type: '{ origin: number; coefficients: readonly number[] }',
      required: true,
      description:
        '유한한 origin과 비어 있지 않은 유한 coefficients로 높이별 Taylor 반지름 배율을 정의하며 모든 표본 반지름은 양수여야 합니다.',
    },
    {
      name: 'azimuthalSegments',
      type: 'number',
      required: false,
      default: '64',
      description: '방위각 방향 분할 수이며 4 이상의 안전한 정수입니다.',
    },
    {
      name: 'verticalSegments',
      type: 'number',
      required: false,
      default: '32',
      description: '높이 방향 분할 수이며 1 이상의 안전한 정수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '중심이 원점에 있고 기본 축은 +Z이며 양 끝은 z = ±height/2에 있습니다.',
  surfaces: ['Bottom', 'Side', 'Top'],
  example:
    '<CurvedEdgeCylinder id="body" height={20} azimuthalCurve={[{ amplitude: 5, phase: 0 }]} verticalCurve={{ origin: 0, coefficients: [1] }} />',
} as const satisfies CadElementManifest<'curvedEdgeCylinder'>
