import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type ShellAttributes = Readonly<{
  offsets: Readonly<Record<string, number>>
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
  children?: unknown
}>

export const shellManifest = {
  tag: 'shell',
  category: 'operation',
  syntax: '<shell offsets={{ inner: -1, outer: 1 }}>Geometry</shell>',
  summary: '닫힌 Geometry의 signed offset 경계 사이에 다층 shell solid를 생성합니다.',
} as const satisfies CadElementManifest<'shell'>
