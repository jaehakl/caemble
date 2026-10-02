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
  height?: number
  azimuthalCurve?: readonly CurvedEdgeCylinderFourierMode[]
  verticalCurve?: CurvedEdgeCylinderTaylorCurve
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
    {
      name: 'height',
      type: 'number',
      required: false,
      default: '1',
      authoringValue: '1',
      description: 'Z축 방향의 전체 높이입니다.',
    },
    {
      name: 'azimuthalCurve',
      type: 'readonly { amplitude: number; phase: number }[]',
      required: false,
      default: '[{ amplitude: 0.5, phase: 0 }]',
      authoringValue: '[{ amplitude: 0.5, phase: 0 }]',
      description: '방위각 방향 Fourier mode 배열입니다.',
    },
    {
      name: 'verticalCurve',
      type: '{ origin: number; coefficients: readonly number[] }',
      required: false,
      default: '{ origin: 0, coefficients: [1] }',
      authoringValue: '{ origin: 0, coefficients: [1] }',
      description: 'origin과 coefficients로 높이별 Taylor 반지름 배율을 정의합니다.',
    },
    {
      name: 'azimuthalSegments',
      type: 'number',
      required: false,
      default: '64',
      authoringValue: '64',
      description: '방위각 방향 분할 수입니다.',
    },
    {
      name: 'verticalSegments',
      type: 'number',
      required: false,
      default: '32',
      authoringValue: '32',
      description: '높이 방향 분할 수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '중심이 원점에 있고 기본 축은 +Z이며 양 끝은 z = ±height/2에 있습니다.',
  surfaces: [
    { index: 0, label: 'Bottom', description: '로컬 -Z 끝 cap입니다.' },
    { index: 1, label: 'Side', description: '곡률이 적용된 옆면입니다.' },
    { index: 2, label: 'Top', description: '로컬 +Z 끝 cap입니다.' },
  ],
  example:
    '<CurvedEdgeCylinder id="body" height={20} azimuthalCurve={[{ amplitude: 5, phase: 0 }]} verticalCurve={{ origin: 0, coefficients: [1] }} />',
} as const satisfies CadElementManifest<'curvedEdgeCylinder'>
