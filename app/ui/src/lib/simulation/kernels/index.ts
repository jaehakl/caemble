import { dcCurrentDensity, dcCurrentDensityKernel } from './dcCurrentDensity'
import { steadyStateHeat, steadyStateHeatKernel } from './steadyStateHeat'

export {
  dcCurrentDensity,
  dcCurrentDensityDescriptor,
  dcCurrentDensityKernel,
  dcCurrentDensityKernelRef,
} from './dcCurrentDensity'

export type {
  DcArtifactTypes,
  DcCurrentDensityBoundaryCondition,
  DcCurrentDensityInitialization,
  DcCurrentDensityOutputRequest,
  DcCurrentDensityTaskConfig,
  PreparedDcInput,
  ResolvedSurface,
} from './dcCurrentDensity'

export {
  steadyStateHeat,
  steadyStateHeatDescriptor,
  steadyStateHeatKernel,
  steadyStateHeatKernelRef,
} from './steadyStateHeat'

export type {
  PreparedSteadyStateHeatInput,
  SteadyStateHeatArtifactTypes,
  SteadyStateHeatBoundaryCondition,
  SteadyStateHeatInitialization,
  SteadyStateHeatOutputRequest,
  SteadyStateHeatTaskConfig,
} from './steadyStateHeat'

const productionKernelCatalog = Object.freeze([
  Object.freeze({
    authoringName: 'dcCurrentDensity',
    builder: dcCurrentDensity,
    definition: dcCurrentDensityKernel,
  }),
  Object.freeze({
    authoringName: 'steadyStateHeat',
    builder: steadyStateHeat,
    definition: steadyStateHeatKernel,
  }),
])

export const kernelModules = Object.freeze(productionKernelCatalog.map(({ definition }) => definition))

export const kernelAuthoring = Object.freeze(
  Object.fromEntries(productionKernelCatalog.map(({ authoringName, builder }) => [authoringName, builder])),
)
