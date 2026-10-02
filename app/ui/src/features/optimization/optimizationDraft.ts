import type { OptimizationAxis } from '@/contracts/api/optimization'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { optimizationAxes } from './variables'

export type OptimizationDraft = {
  axes: OptimizationAxis[]
  name: string
  objectiveId: string
  direction: 'minimize' | 'maximize'
  constraints: { calculationId: string; minimum: string; maximum: string }[]
  maxTrials: number
  maxParallel: number
  hybrid: boolean
  modelId: string
  modelRevision: string
  replicaId: string
  launcherId: string
  maxSolverRuns: number
  qualityRequirements: { recordId: number; component: string; rmseMaximum: string }[]
}

export function createOptimizationDraft(workbench: CaeWorkbenchState): OptimizationDraft {
  return {
    axes: optimizationAxes(workbench.experimentDocument.varsSchema!),
    name: `${workbench.experimentName} 최적화`,
    objectiveId: String(workbench.selectionContext.calculationId ?? ''),
    direction: 'minimize',
    constraints: [],
    maxTrials: 20,
    maxParallel: 2,
    hybrid: false,
    modelId: '',
    modelRevision: '',
    replicaId: '',
    launcherId: '',
    maxSolverRuns: 8,
    qualityRequirements: [],
  }
}
