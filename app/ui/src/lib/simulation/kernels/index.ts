import { dcCurrentDensity, dcCurrentDensityDescriptor } from './dcCurrentDensity'
import { steadyStateHeat, steadyStateHeatDescriptor } from './steadyStateHeat'

export { dcCurrentDensity, dcCurrentDensityDescriptor, dcCurrentDensityKernelRef } from './dcCurrentDensity'

export type {
  DcArtifactTypes,
  DcCurrentDensityBoundaryCondition,
  DcCurrentDensityInitialization,
  DcCurrentDensityOutputRequest,
  DcCurrentDensityTaskConfig,
  PreparedDcInput,
  ResolvedSurface,
} from './dcCurrentDensity'

export { steadyStateHeat, steadyStateHeatDescriptor, steadyStateHeatKernelRef } from './steadyStateHeat'

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
    descriptor: dcCurrentDensityDescriptor,
  }),
  Object.freeze({
    authoringName: 'steadyStateHeat',
    builder: steadyStateHeat,
    descriptor: steadyStateHeatDescriptor,
  }),
])

export const kernelModules = Object.freeze(
  productionKernelCatalog.map(({ descriptor }) => Object.freeze({ descriptor })),
)

export const kernelAuthoring = Object.freeze(
  Object.fromEntries(productionKernelCatalog.map(({ authoringName, builder }) => [authoringName, builder])),
)
