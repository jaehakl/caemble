import { transforms } from '@jscad/modeling'
import type { CadScene, CadScenePart, CadSceneSurface } from '../../../cad/evaluation/types'
import { CadModelError, type DataValueDescriptor } from '../../../cad/model/core'
import { convertUcumValue } from '../../../cad/model/units'
import { normalizeKernelTaskConfig, type KernelPrepareContext, type KernelPrepareResult } from '../../kernelContract'
import { isotropicIdentityTensorValue, maximumVoxelCount } from '../voxelFiniteVolume'
import { steadyStateHeatDescriptor, type SteadyStateHeatTaskConfig } from './descriptor'

type ResolvedSurface = Readonly<{
  part: CadScenePart
  surface: CadSceneSurface
}>

export type PreparedSteadyStateHeatInput = Readonly<{
  domain: CadScenePart
  sourceTerminal: ResolvedSurface
  referenceTerminal: ResolvedSurface
  thermalConductivity: number
  gridShape: readonly [number, number, number]
  sourceTemperature: number
  referenceTemperature: number
  relativeTolerance: number
  maxIterations: number
  outputs: readonly Readonly<{
    key: string
    methodId: 'heat.temperature' | 'heat.maximum-temperature'
  }>[]
}>

function groupName(target: string, source: 'structure', kind: 'geometry' | 'surface') {
  const prefix = `${source}.${kind}.`
  if (!target.startsWith(prefix) || !target.slice(prefix.length)) {
    throw new CadModelError(`Heat target ${target} must match ${prefix}<group>.`)
  }
  return target.slice(prefix.length)
}

function geometryPart(scene: CadScene, name: string) {
  const group = scene.geometryGroups.find((candidate) => candidate.name === name)
  if (!group || group.geometryIds.length !== 1) {
    throw new CadModelError(`Heat domain group "${name}" must resolve to exactly one Geometry part.`)
  }
  const part = scene.parts.find((candidate) => candidate.id === group.geometryIds[0])
  if (!part) throw new CadModelError(`Heat domain Geometry ${group.geometryIds[0]} is missing.`)
  return part
}

function surfaceForGroup(scene: CadScene, name: string) {
  const group = scene.surfaceGroups.find((candidate) => candidate.name === name)
  if (!group || group.surfaceIds.length !== 1) {
    throw new CadModelError(`Heat fixed-temperature group "${name}" must resolve to exactly one Surface.`)
  }
  const surfaceId = group.surfaceIds[0]
  for (const part of scene.parts) {
    const surface = part.surfaces.find((candidate) => candidate.id === surfaceId)
    if (surface) return { part, surface }
  }
  throw new CadModelError(`Heat fixed-temperature Surface ${surfaceId} is missing.`)
}

function parameterNumber(value: unknown, path: string) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { value?: unknown }).value !== 'number'
  ) {
    throw new CadModelError(`${path} must be a scalar data descriptor.`)
  }
  return (value as { value: number }).value
}

export function prepareSteadyStateHeat(
  context: KernelPrepareContext<SteadyStateHeatTaskConfig>,
): KernelPrepareResult<PreparedSteadyStateHeatInput> {
  const config = normalizeKernelTaskConfig(
    steadyStateHeatDescriptor,
    context.config,
    context.world,
  ) as SteadyStateHeatTaskConfig
  const scene = context.world.scenes.structure
  const gridRule = config.initializations[0]
  const domainGroup = groupName(gridRule.target[0], 'structure', 'geometry')
  const rawDomain = geometryPart(scene, domainGroup)
  if (!rawDomain.material) {
    throw new CadModelError(`Heat domain ${rawDomain.id} must have a Material.`)
  }

  config.outputs.forEach((output) => {
    if (groupName(output.target[0], 'structure', 'geometry') !== domainGroup) {
      throw new CadModelError('Heat voxel grid and every output request must target the same domain group.')
    }
  })

  const sourceRule = config.boundaryConditions[0]
  const referenceRule = config.boundaryConditions[1]
  const source = surfaceForGroup(scene, groupName(sourceRule.target[0], 'structure', 'surface'))
  const reference = surfaceForGroup(scene, groupName(referenceRule.target[0], 'structure', 'surface'))
  if (source.part.id !== rawDomain.id || reference.part.id !== rawDomain.id) {
    throw new CadModelError('Both fixed-temperature surfaces must belong to the Heat domain Geometry.')
  }
  if (source.surface.id === reference.surface.id) {
    throw new CadModelError('Heat fixed-temperature conditions must target different terminal surfaces.')
  }

  const lengthScale = convertUcumValue(1, scene.lengthUnit, 'm', 'Heat Structure lengthUnit')
  const domain = Object.freeze({
    ...rawDomain,
    geometry: transforms.scale([lengthScale, lengthScale, lengthScale], rawDomain.geometry as never),
    surfaces: Object.freeze(
      rawDomain.surfaces.map((surface) =>
        Object.freeze({
          ...surface,
          polygonIndices: Object.freeze([...surface.polygonIndices]),
        }),
      ),
    ),
  }) as unknown as CadScenePart
  const surfaceById = new Map(domain.surfaces.map((surface) => [surface.id, surface]))
  const gridShape = (gridRule.parameters.gridShape as DataValueDescriptor).value as [number, number, number]
  if (gridShape[0] * gridShape[1] * gridShape[2] > maximumVoxelCount) {
    throw new CadModelError(`heat.voxel-grid gridShape may contain at most ${maximumVoxelCount} voxels.`)
  }

  return Object.freeze({
    prepared: Object.freeze({
      domain,
      sourceTerminal: Object.freeze({
        part: domain,
        surface: surfaceById.get(source.surface.id)!,
      }),
      referenceTerminal: Object.freeze({
        part: domain,
        surface: surfaceById.get(reference.surface.id)!,
      }),
      thermalConductivity: isotropicIdentityTensorValue(
        rawDomain.material.variables['thermal.conductivity'],
        'Thermal domain Material thermal.conductivity',
        'W.m-1.K-1',
      ),
      gridShape: Object.freeze([...gridShape]) as unknown as readonly [number, number, number],
      sourceTemperature: parameterNumber(
        sourceRule.parameters.temperature,
        'heat.fixed-temperature source temperature',
      ),
      referenceTemperature: parameterNumber(
        referenceRule.parameters.temperature,
        'heat.fixed-temperature reference temperature',
      ),
      relativeTolerance: parameterNumber(config.parameters.relativeTolerance, 'steady-state-heat relativeTolerance'),
      maxIterations: parameterNumber(config.parameters.maxIterations, 'steady-state-heat maxIterations'),
      outputs: Object.freeze(
        config.outputs.map((output) =>
          Object.freeze({
            key: output.key,
            methodId: output.methodId,
          }),
        ),
      ),
    }),
  })
}
