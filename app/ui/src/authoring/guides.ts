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
    title: 'Develop and test an Experiment source bundle',
    summary: 'Read the live contract, edit the complete bundle, build locally, then run and inspect recorded results.',
    sourcePaths: [
      'docs/authoring/experiment.md',
      'AGENTS.md',
      'app/ui/src/lib/cad/api/caemble-core.d.ts',
      'app/ui/src/lib/cad/api/cad-jsx.d.ts',
      'app/ui/src/lib/cad/elements/manifest.json',
      'app/ui/src/lib/cad/source/sourceAnalysis.ts',
      'app/ui/src/lib/cad/source/sourcePolicy.ts',
      'app/ui/src/lib/cad/source/moduleResolution.ts',
      'app/slaves/cae/app/kernel/coordinator/program.py',
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
    title: 'Develop and validate a Calculation',
    summary:
      'Use precise JavaScript and fixed record dependencies, execute against a reproducible input snapshot, then save the validated contract.',
    sourcePaths: [
      'docs/authoring/calculation.md',
      'app/ui/src/lib/calculation/declarations.ts',
      'app/ui/src/lib/calculation/policyContract.ts',
      'app/ui/src/lib/calculation/sourcePolicy.ts',
      'app/ui/src/lib/calculation/dependencies.ts',
      'app/ui/src/lib/calculation/validation.ts',
      'app/ui/src/lib/calculation/mathjsManifest.ts',
      'app/ui/src/authoring/examples.ts',
      'app/ui/src/platform/node/calculation.ts',
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
    title: 'Develop a Solver in the existing CAE architecture',
    summary:
      'Use the live Catalog Draft workflow and ABI 3 implementation, then validate a complete Experiment through the common builder.',
    sourcePaths: [
      'docs/authoring/solver.md',
      'docs/development/solver-development.md',
      'app/slaves/cae/AGENTS.md',
      'app/slaves/cae/app/kernel/api',
      'app/slaves/cae/app/methods',
      'app/slaves/cae/app/solvers',
      'app/catalog/caemble_catalog',
      'app/slaves/cae/tests',
    ],
    referenceIds: ['solver.workflow', 'experiment.contract', 'experiment.simulate', 'diagnostic.experiment'],
    content: documentBody(solverMarkdown),
  },
]
