import { defineKernelTask } from '../../authoring'
import type { DefinedKernelTask } from '../../types'
import {
  steadyStateHeatDescriptor,
  type SteadyStateHeatArtifactTypes,
  type SteadyStateHeatTaskConfig,
} from './descriptor'

export {
  steadyStateHeatDescriptor,
  type SteadyStateHeatArtifactTypes,
  type SteadyStateHeatBoundaryCondition,
  type SteadyStateHeatInitialization,
  type SteadyStateHeatOutputRequest,
  type SteadyStateHeatTaskConfig,
} from './descriptor'
export type { PreparedSteadyStateHeatInput } from './prepare'

export const steadyStateHeatKernelRef = Object.freeze({
  name: steadyStateHeatDescriptor.name,
  version: steadyStateHeatDescriptor.version,
})

export function steadyStateHeat<const Config extends SteadyStateHeatTaskConfig>(
  config: Config,
): DefinedKernelTask<
  Config,
  SteadyStateHeatArtifactTypes<Config>,
  Readonly<{ iterations: number; relativeResidual: number }>,
  Readonly<{ heatSource: 'caemble.dc/joule-heating@1' | undefined }>
> {
  return defineKernelTask<
    Config,
    SteadyStateHeatArtifactTypes<Config>,
    Readonly<{ iterations: number; relativeResidual: number }>,
    Readonly<{ heatSource: 'caemble.dc/joule-heating@1' | undefined }>
  >(steadyStateHeatDescriptor, config)
}
