import {
  optimizationModelUpdatePolicySchema,
  type OptimizationAxis,
  type OptimizationHybrid,
} from '@/contracts/api/optimization'
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
  algorithmId: 'coordinate' | 'random' | 'de'
  initialStep: number
  minStep: number
  randomSeed: number
  candidatesPerRound: number
  deSeed: number
  populationSize: number
  mutationFactor: number
  crossoverRate: number
  hybrid: boolean
  modelId: string
  modelRevision: string
  replicaId: string
  launcherId: string
  maxSolverRuns: number
  qualityRequirements: { recordId: number; component: string; rmseMaximum: string }[]
  automaticUpdates: boolean
  modelUpdateConfig: NonNullable<OptimizationHybrid['model_update_policy']>['config']
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
    algorithmId: 'coordinate',
    initialStep: 0.25,
    minStep: 0.001,
    randomSeed: 0,
    candidatesPerRound: 8,
    deSeed: 0,
    populationSize: 8,
    mutationFactor: 0.8,
    crossoverRate: 0.9,
    hybrid: false,
    modelId: '',
    modelRevision: '',
    replicaId: '',
    launcherId: '',
    maxSolverRuns: 8,
    qualityRequirements: [],
    automaticUpdates: false,
    modelUpdateConfig: optimizationModelUpdatePolicySchema.parse({ id: 'new_solver_results' }).config,
  }
}
