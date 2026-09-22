import { publicDocuments } from './public'
import type { HelpKindId } from './types'

/** The sidebar, home links and reading order share these groups. */
export const documentationGroups = [
  {
    title: '시작하기',
    description: '예제를 열고, Caemble의 기본 개념과 작업 흐름을 익힙니다.',
    ids: ['workbench-quickstart', 'workbench-authoring-cycle', 'workbench-showcase'],
  },
  {
    title: '화면 사용법',
    description: '조건을 바꾸고 실행한 뒤, 결과를 계산하고 비교합니다.',
    ids: [
      'workbench-measurement',
      'workbench-save',
      'workbench-viewer-selection',
      'workbench-calculation',
      'workbench-prediction',
      'workbench-analysis',
      'workbench-admin-demo-curation',
    ],
  },
  {
    title: '코드로 실험 작성하기',
    description: '형상과 재료, 계산 작업과 실행 순서를 직접 작성합니다.',
    ids: [
      'program-overview',
      'program-definition',
      'program-materials',
      'program-task',
      'program-simulate',
      'program-domain-recording',
      'program-runtime-rules',
    ],
  },
  {
    title: '분야별 예제',
    description: '검증된 예제로 광선 추적, 입자 해석과 복합 해석을 살펴봅니다.',
    ids: ['program-verified-examples', 'program-ray-tracing', 'program-particles', 'program-multiphysics-example'],
  },
  {
    title: '문제 해결',
    description: '지금 보이는 증상을 바탕으로 확인할 곳을 찾습니다.',
    ids: publicDocuments.filter((page) => page.section === 'troubleshooting').map((page) => page.id),
  },
  {
    title: '문법과 상세 참조',
    description: '형상, 데이터와 단위의 정확한 작성 규칙을 확인합니다.',
    ids: publicDocuments
      .filter((page) => page.section === 'reference' && !page.id.startsWith('authoring-'))
      .map((page) => page.id),
  },
  {
    title: 'CLI 작성 가이드',
    description: '터미널에서 소스를 작성하고 검증하는 절차를 안내합니다.',
    ids: ['authoring-experiment', 'authoring-calculation', 'authoring-solver'],
  },
] as const

export const documentationCatalogs: readonly { kind: HelpKindId; label: string; description: string }[] = [
  { kind: 'geometry', label: '형상 · Geometry', description: '기본 도형과 조합 방법' },
  { kind: 'materials', label: '재료 · Material', description: '재료 모델과 입력 계수' },
  { kind: 'quantity-kinds', label: '물리량 · QuantityKind', description: '물리적 의미와 사용 단위' },
  { kind: 'solvers', label: '해석 도구 · Solver', description: '해석별 입력과 출력 규격' },
  { kind: 'examples', label: '실행 예제 · Examples', description: '바로 열어 볼 수 있는 실험' },
]

export const documentationSectionLabels: Record<string, string> = {
  workbench: '화면 사용법',
  program: '실험 작성과 예제',
  reference: '문법과 작성 가이드',
  troubleshooting: '문제 해결',
  ...Object.fromEntries(documentationCatalogs.map(({ kind, label }) => [kind, label])),
}
