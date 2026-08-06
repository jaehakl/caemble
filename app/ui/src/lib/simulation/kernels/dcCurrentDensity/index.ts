import { defineKernelTask } from '../../authoring'
import type { DefinedKernelTask } from '../../types'
import { dcCurrentDensityDescriptor, type DcArtifactTypes, type DcCurrentDensityTaskConfig } from './descriptor'

export {
  dcCurrentDensityDescriptor,
  type DcArtifactTypes,
  type DcCurrentDensityBoundaryCondition,
  type DcCurrentDensityInitialization,
  type DcCurrentDensityOutputRequest,
  type DcCurrentDensityTaskConfig,
} from './descriptor'
export type { PreparedDcInput, ResolvedSurface } from './prepare'

export const dcCurrentDensityKernelRef = Object.freeze({
  name: dcCurrentDensityDescriptor.name,
  version: dcCurrentDensityDescriptor.version,
})

export function dcCurrentDensity<const Config extends DcCurrentDensityTaskConfig>(
  config: Config,
): DefinedKernelTask<
  Config,
  DcArtifactTypes<Config>,
  Readonly<{ iterations: number; relativeResidual: number }>,
  Readonly<Record<string, never>>
> {
  return defineKernelTask<
    Config,
    DcArtifactTypes<Config>,
    Readonly<{ iterations: number; relativeResidual: number }>,
    Readonly<Record<string, never>>
  >(dcCurrentDensityDescriptor, config)
}
