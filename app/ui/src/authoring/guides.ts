import experimentMarkdown from '../../../../docs/authoring/experiment.md?raw'
import calculationMarkdown from '../../../../docs/authoring/calculation.md?raw'
import solverMarkdown from '../../../../docs/authoring/solver.md?raw'
import { documentBody } from '@/documentation/body'

export type AuthoringScenario = 'experiment' | 'calculation' | 'solver'
export type AuthoringGuide = Readonly<{
  id: AuthoringScenario
  title: string
  summary: string
  content: string
  sourcePaths: readonly string[]
  referenceIds: readonly string[]
}>

export const authoringGuides: readonly AuthoringGuide[] = [
  {
    id: 'experiment',
    title: 'CLI로 Experiment 작성하고 실행하기',
    summary: '실행 가능한 예제에서 시작해 소스를 검사하고, 로컬 해석과 결과 확인을 거쳐 서버에 저장합니다.',
    sourcePaths: [
      'docs/authoring/experiment.md',
      'AGENTS.md',
      'shared/execution/src/cad/api/caemble-core.d.ts',
      'shared/execution/src/cad/api/cad-jsx.d.ts',
      'shared/execution/src/cad/elements/manifest.json',
      'shared/execution/src/cad/source/sourceAnalysis.ts',
      'shared/execution/src/cad/source/sourcePolicy.ts',
      'shared/execution/src/cad/source/moduleResolution.ts',
      'app/slaves/cae_simulation/app/kernel/coordinator/program.py',
      'app/ui/scripts/test-catalog-examples.ts',
    ],
    referenceIds: [
      'experiment.contract',
      'experiment.modules',
      'experiment.materials',
      'experiment.geometry',
      'experiment.simulate',
      'diagnostic.experiment',
    ],
    content: documentBody(experimentMarkdown),
  },
  {
    id: 'calculation',
    title: 'CLI로 Calculation 작성하고 검증하기',
    summary:
      '기록된 수치로 후처리 코드를 작성하고, 정답이 있는 예제와 실제 데이터로 검증한 뒤 정의와 결과를 저장합니다.',
    sourcePaths: [
      'docs/authoring/calculation.md',
      'shared/execution/src/calculation/declarations.ts',
      'shared/execution/src/calculation/policyContract.ts',
      'shared/execution/src/calculation/sourcePolicy.ts',
      'shared/execution/src/calculation/dependencies.ts',
      'shared/execution/src/calculation/validation.ts',
      'shared/execution/src/calculation/mathjsManifest.ts',
      'app/ui/src/authoring/examples.ts',
      'shared/execution/src/node/calculation.ts',
    ],
    referenceIds: [
      'calculation.contract',
      'calculation.declarations',
      'calculation.dependencies',
      'calculation.snapshot',
      'calculation.example.mean',
      'calculation.example.line',
      'calculation.example.heatmap',
      'diagnostic.calculation',
    ],
    content: documentBody(calculationMarkdown),
  },
  {
    id: 'solver',
    title: 'CLI로 Solver 개발하고 검증하기',
    summary:
      '기존 CAE 구조와 ABI 3에 맞춰 Solver를 구현하고, Catalog Draft와 전체 실험 예제로 입력·수치 결과를 검증합니다.',
    sourcePaths: [
      'docs/authoring/solver.md',
      'docs/development/solver-development.md',
      'app/slaves/cae_simulation/AGENTS.md',
      'app/slaves/cae_simulation/app/kernel/api',
      'app/slaves/cae_simulation/app/methods',
      'app/slaves/cae_simulation/app/solvers',
      'shared/catalog/caemble_catalog',
      'app/slaves/cae_simulation/tests',
    ],
    referenceIds: ['solver.workflow', 'experiment.contract', 'experiment.simulate', 'diagnostic.experiment'],
    content: documentBody(solverMarkdown),
  },
]
