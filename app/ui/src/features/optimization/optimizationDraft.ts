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
  }
}
