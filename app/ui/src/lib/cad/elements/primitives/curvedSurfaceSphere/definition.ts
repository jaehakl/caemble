import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type CurvedSurfaceSphereFourierMode = Readonly<{
  amplitude: number
  phase: number
}>

export type CurvedSurfaceSphereAttributes = Readonly<{
  azimuthalCurve: readonly CurvedSurfaceSphereFourierMode[]
  polarCurve: readonly CurvedSurfaceSphereFourierMode[]
  azimuthalSegments?: number
  polarSegments?: number
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const curvedSurfaceSphereManifest = {
  tag: 'curvedSurfaceSphere',
  category: 'primitive',
  syntax: '<curvedSurfaceSphere azimuthalCurve={modes} polarCurve={modes} />',
  summary: '방위각과 polar angle의 Fourier 곡선 곱으로 중심 반지름이 정해지는 닫힌 구면을 생성합니다.',
} as const satisfies CadElementManifest<'curvedSurfaceSphere'>
