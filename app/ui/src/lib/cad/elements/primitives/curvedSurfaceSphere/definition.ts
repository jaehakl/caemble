import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type CurvedSurfaceSphereFourierMode = Readonly<{
  amplitude: number
  phase: number
}>

export type CurvedSurfaceSphereAttributes = Readonly<{
  azimuthalCurve?: readonly CurvedSurfaceSphereFourierMode[]
  polarCurve?: readonly CurvedSurfaceSphereFourierMode[]
  azimuthalSegments?: number
  polarSegments?: number
}> &
  IntrinsicGeometryAttributes

export const curvedSurfaceSphereManifest = {
  tag: 'curvedSurfaceSphere',
  authoringName: 'CurvedSurfaceSphere',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<CurvedSurfaceSphere azimuthalCurve={modes} polarCurve={modes} />',
  summary: '방위각과 polar angle의 Fourier 곡선 곱으로 중심 반지름이 정해지는 닫힌 구면을 생성합니다.',
  keywords: ['curved surface sphere', 'fourier sphere', '곡면 구', '푸리에'],
  properties: [
    {
      name: 'azimuthalCurve',
      type: 'readonly { amplitude: number; phase: number }[]',
      required: false,
      default: '[{ amplitude: 0.5, phase: 0 }]',
      authoringValue: '[{ amplitude: 0.5, phase: 0 }]',
      description: '방위각 방향 Fourier mode 배열입니다.',
    },
    {
      name: 'polarCurve',
      type: 'readonly { amplitude: number; phase: number }[]',
      required: false,
      default: '[{ amplitude: 1, phase: 0 }]',
      authoringValue: '[{ amplitude: 1, phase: 0 }]',
      description: 'polar angle 방향 Fourier mode 배열입니다.',
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
      name: 'polarSegments',
      type: 'number',
      required: false,
      default: '32',
      authoringValue: '32',
      description: '극각 방향 분할 수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '변형된 구면의 중심이 원점에 있고 극축은 +Z입니다.',
  surfaces: [{ index: 0, label: 'Outer', description: '곡률이 적용된 구의 바깥쪽 표면입니다.' }],
  example:
    '<CurvedSurfaceSphere id="particle" azimuthalCurve={[{ amplitude: 5, phase: 0 }]} polarCurve={[{ amplitude: 1, phase: 0 }]} />',
} as const satisfies CadElementManifest<'curvedSurfaceSphere'>
