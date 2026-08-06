import type { Rotation, Vec3 } from '../../../model/types'
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
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const curvedEdgeCylinderManifest = {
  tag: 'curvedEdgeCylinder',
  category: 'primitive',
  syntax: '<curvedEdgeCylinder height={h} azimuthalCurve={modes} verticalCurve={{origin,coefficients}} />',
  summary: 'Fourier 방위 곡선과 Taylor 높이 곡선의 곱으로 반지름이 정해지는 닫힌 원기둥을 생성합니다.',
} as const satisfies CadElementManifest<'curvedEdgeCylinder'>
