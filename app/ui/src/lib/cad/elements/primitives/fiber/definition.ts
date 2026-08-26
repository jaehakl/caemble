import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Vec3 } from '../../../model/types'
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
  from?: Vec3
  to?: Vec3
  basePath?: (t: number) => Vec3
  radius?: number | ((s: number) => number)
  helix?: FiberHelix
  fourier?: readonly FiberFourierMode[]
  envelopePower?: number
  up?: Vec3
  pathSegments?: number
  radialSegments?: number
}> &
  IntrinsicGeometryAttributes

export const fiberManifest = {
  tag: 'fiber',
  authoringName: 'Fiber',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Fiber from={p0} to={p1} radius={(s) => r} helix={{turns,phase,radius}} fourier={modes} />',
  summary: '두 점 사이의 절차적 중심선을 가변 반지름 원형 단면으로 sweep합니다.',
  keywords: ['fiber', 'sweep', 'tube', 'helix', '섬유', '튜브', '나선'],
  properties: [
    {
      name: 'from',
      type: 'Vec3',
      required: false,
      default: '[0, 0, -0.5]',
      authoringValue: '[0, 0, -0.5]',
      description: '정확히 세 유한 좌표인 중심선 시작점이며 to와 달라야 합니다.',
    },
    {
      name: 'to',
      type: 'Vec3',
      required: false,
      default: '[0, 0, 0.5]',
      authoringValue: '[0, 0, 0.5]',
      description: '정확히 세 유한 좌표인 중심선 끝점이며 from과 달라야 합니다.',
    },
    {
      name: 'basePath',
      type: '(t: number) => Vec3',
      required: false,
      default: 'straight line from from to to',
      authoringValue: 'undefined',
      description:
        '0≤t≤1에서 유한 Vec3 중심선을 정의하며 양 끝은 from과 to에 일치하고 연속 표본이 중복되어 길이 0인 구간을 만들면 안 됩니다.',
    },
    {
      name: 'radius',
      type: 'number | ((s: number) => number)',
      required: false,
      default: '0.05',
      authoringValue: '0.05',
      description: '정규화된 호 길이의 모든 표본에서 유한한 양수를 반환하는 단면 반지름입니다.',
    },
    {
      name: 'helix',
      type: 'FiberHelix',
      required: false,
      default: 'none',
      authoringValue: 'undefined',
      description: '유한 turns/phase와 모든 표본에서 유한한 0 이상 radius를 갖는 나선 변위입니다.',
    },
    {
      name: 'fourier',
      type: 'readonly FiberFourierMode[]',
      required: false,
      default: 'none',
      authoringValue: 'undefined',
      description: '지정 시 비어 있지 않아야 하며 각 mode는 유한한 0 이상 amplitude와 유한 phase를 가집니다.',
    },
    {
      name: 'envelopePower',
      type: 'number',
      required: false,
      default: '2',
      authoringValue: '2',
      description: '끝점에서 변위를 감쇠하는 유한한 1 이상 envelope 지수입니다.',
    },
    {
      name: 'up',
      type: 'Vec3',
      required: false,
      default: 'automatic Bishop frame',
      authoringValue: 'undefined',
      description: '초기 path tangent와 평행하지 않은 유한한 기준 방향입니다.',
    },
    {
      name: 'pathSegments',
      type: 'number',
      required: false,
      default: '128',
      authoringValue: '128',
      description: '중심선 방향 분할 수이며 8~2048 범위의 정수입니다.',
    },
    {
      name: 'radialSegments',
      type: 'number',
      required: false,
      default: '12',
      authoringValue: '12',
      description: '원형 단면 분할 수이며 3~64 범위의 정수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: 'from/to 또는 basePath가 정의한 좌표를 그대로 사용하며 별도의 중심 보정은 하지 않습니다.',
  surfaces: [
    { index: 0, label: 'Start cap', description: 'Fiber path의 시작 단면입니다.' },
    { index: 1, label: 'Side', description: 'Fiber path를 따라 생성된 옆면입니다.' },
    { index: 2, label: 'End cap', description: 'Fiber path의 끝 단면입니다.' },
  ],
  example: '<Fiber id="strand" from={[0, 0, 0]} to={[0, 0, 20]} radius={1} />',
} as const satisfies CadElementManifest<'fiber'>
