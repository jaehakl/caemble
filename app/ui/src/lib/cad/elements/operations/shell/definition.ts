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
      description:
        '비어 있지 않은 Material role별 signed offset입니다. role은 비어 있지 않고 앞뒤 공백이 없어야 하며 값은 서로 다른 유한한 0 아닌 수여야 합니다.',
    },
  ],
  children: {
    count: 'one',
    description: '정확히 하나의 유효한 닫힌 양의 부피 solid를 받으며 각 offset에서도 퇴화·반전되지 않아야 합니다.',
  },
  origin: '자식 좌표를 유지한 채 생성된 shell 결과에 이 element의 transform을 적용합니다.',
  surfaces: ['Surface 1', 'Surface 2', '…'],
  example: '<shell id="coating" offsets={{ inner: -1, outer: 1 }}><Sphere radius={10} /></shell>',
} as const satisfies CadElementManifest<'shell'>
