import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type ShellAttributes = Readonly<{
  offsets: Readonly<Record<string, number>>
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export const shellManifest = {
  tag: 'shell',
  authoringName: 'shell',
  category: 'operation',
  standardTransforms: true,
  syntax: '<shell offsets={{ inner: -1, outer: 1 }}>Geometry</shell>',
  summary: '닫힌 Geometry의 signed offset 경계 사이에 다층 shell solid를 생성합니다.',
  keywords: ['shell', 'offset', 'layer', 'coating', '쉘', '오프셋', '코팅'],
  properties: [
    {
      name: 'offsets',
      type: 'Readonly<Record<string, number>>',
      required: true,
      authoringValue: '{ inner: -1, outer: 1 }',
      description: 'Material role별 signed offset입니다.',
    },
  ],
  children: {
    count: 'one',
    description: 'shell 경계를 생성할 닫힌 solid를 받습니다.',
  },
  origin: '자식 좌표를 유지한 채 생성된 shell 결과에 이 element의 transform을 적용합니다.',
  surfaces: [
    { index: 0, label: 'Inner', description: '각 shell layer의 안쪽 경계입니다.' },
    { index: 1, label: 'Outer', description: '각 shell layer의 바깥쪽 경계입니다.' },
  ],
  example: '<shell id="coating" offsets={{ inner: -1, outer: 1 }}><Sphere radius={10} /></shell>',
} as const satisfies CadElementManifest<'shell'>
