import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type FiberFourierMode = Readonly<{
  amplitude: number
  phase: number
}>

export type FiberHelix = Readonly<{
  turns: number
  phase?: number
  radius: number | ((u: number, theta: number) => number)
}>

export type FiberAttributes = Readonly<{
  from: Vec3
  to: Vec3
  basePath?: (t: number) => Vec3
  radius: number | ((s: number) => number)
  helix?: FiberHelix
  fourier?: readonly FiberFourierMode[]
  envelopePower?: number
  up?: Vec3
  pathSegments?: number
  radialSegments?: number
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const fiberManifest = {
  tag: 'fiber',
  category: 'primitive',
  syntax: '<fiber from={p0} to={p1} radius={(s) => r} helix={{turns,phase,radius}} fourier={modes} />',
  summary: '두 점 사이의 절차적 중심선을 가변 반지름 원형 단면으로 sweep합니다.',
} as const satisfies CadElementManifest<'fiber'>
