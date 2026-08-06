import { transforms } from '@jscad/modeling'
import type { CadScene, CadScenePart, CadSceneSurface } from '../../../cad/evaluation/types'
import { CadModelError, type DataValueDescriptor } from '../../../cad/model/core'
import { convertUcumValue } from '../../../cad/model/units'
import { normalizeKernelTaskConfig, type KernelPrepareContext, type KernelPrepareResult } from '../../kernelContract'
import { isotropicIdentityTensorValue, maximumVoxelCount } from '../voxelFiniteVolume'
import { dcCurrentDensityDescriptor, type DcCurrentDensityTaskConfig } from './descriptor'

export type ResolvedSurface = Readonly<{
  part: CadScenePart
  surface: CadSceneSurface
}>

export type PreparedDcInput = Readonly<{
  conductor: CadScenePart
  sourceTerminal: ResolvedSurface
  referenceTerminal: ResolvedSurface
  conductivity: number
  gridShape: readonly [number, number, number]
  sourceVoltage: number
  referenceVoltage: number
  relativeTolerance: number
  maxIterations: number
  outputs: readonly (
    | Readonly<{
        key: string
        methodId: 'dc.current-density' | 'dc.total-current'
        crossSectionPosition: number
      }>
    | Readonly<{
        key: string
        methodId: 'dc.joule-heating'
      }>
  )[]
}>

function groupName(target: string, source: 'structure', kind: 'geometry' | 'surface') {
  const prefix = `${source}.${kind}.`
  if (!target.startsWith(prefix) || !target.slice(prefix.length)) {
    throw new CadModelError(`DC target ${target} must match ${prefix}<group>.`)
  }
  return target.slice(prefix.length)
}

function geometryPart(scene: CadScene, name: string) {
  const group = scene.geometryGroups.find((candidate) => candidate.name === name)
  if (!group || group.geometryIds.length !== 1) {
    throw new CadModelError(`DC conductor group "${name}" must resolve to exactly one Geometry part.`)
  }
  const part = scene.parts.find((candidate) => candidate.id === group.geometryIds[0])
  if (!part) throw new CadModelError(`DC conductor Geometry ${group.geometryIds[0]} is missing.`)
  return part
}

function surfaceForGroup(scene: CadScene, name: string) {
  const group = scene.surfaceGroups.find((candidate) => candidate.name === name)
  if (!group || group.surfaceIds.length !== 1) {
    throw new CadModelError(`DC terminal group "${name}" must resolve to exactly one Surface.`)
  }
  const surfaceId = group.surfaceIds[0]
  for (const part of scene.parts) {
    const surface = part.surfaces.find((candidate) => candidate.id === surfaceId)
    if (surface) return { part, surface }
  }
  throw new CadModelError(`DC terminal Surface ${surfaceId} is missing.`)
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

export function prepareDcCurrentDensity(
  context: KernelPrepareContext<DcCurrentDensityTaskConfig>,
): KernelPrepareResult<PreparedDcInput> {
  const config = normalizeKernelTaskConfig(
    dcCurrentDensityDescriptor,
    context.config,
    context.world,
  ) as DcCurrentDensityTaskConfig
  const scene = context.world.scenes.structure
  const gridRule = config.initializations[0]
  const conductorGroup = groupName(gridRule.target[0], 'structure', 'geometry')
  const rawConductor = geometryPart(scene, conductorGroup)
  if (!rawConductor.material) {
    throw new CadModelError(`DC conductor ${rawConductor.id} must have a Material.`)
  }

  config.outputs.forEach((output) => {
    if (groupName(output.target[0], 'structure', 'geometry') !== conductorGroup) {
      throw new CadModelError('DC voxel grid and every output request must target the same conductor group.')
    }
  })

  const sourceRule = config.boundaryConditions.find((rule) => rule.methodId === 'dc.source-potential')!
  const referenceRule = config.boundaryConditions.find((rule) => rule.methodId === 'dc.reference-potential')!
  const source = surfaceForGroup(scene, groupName(sourceRule.target[0], 'structure', 'surface'))
  const reference = surfaceForGroup(scene, groupName(referenceRule.target[0], 'structure', 'surface'))
  if (source.part.id !== rawConductor.id || reference.part.id !== rawConductor.id) {
    throw new CadModelError('Both DC terminal surfaces must belong to the conductor Geometry.')
  }
  if (source.surface.id === reference.surface.id) {
    throw new CadModelError('DC source and reference potentials must target different terminal surfaces.')
  }

  const lengthScale = convertUcumValue(1, scene.lengthUnit, 'm', 'DC Structure lengthUnit')
  const conductor = Object.freeze({
    ...rawConductor,
    geometry: transforms.scale([lengthScale, lengthScale, lengthScale], rawConductor.geometry as never),
    surfaces: Object.freeze(
      rawConductor.surfaces.map((surface) =>
        Object.freeze({
          ...surface,
          polygonIndices: Object.freeze([...surface.polygonIndices]),
        }),
      ),
    ),
  }) as unknown as CadScenePart
  const surfaceById = new Map(conductor.surfaces.map((surface) => [surface.id, surface]))
  const gridShape = (gridRule.parameters.gridShape as DataValueDescriptor).value as [number, number, number]
  if (gridShape[0] * gridShape[1] * gridShape[2] > maximumVoxelCount) {
    throw new CadModelError(`dc.voxel-grid gridShape may contain at most ${maximumVoxelCount} voxels.`)
  }

  return Object.freeze({
    prepared: Object.freeze({
      conductor,
      sourceTerminal: Object.freeze({
        part: conductor,
        surface: surfaceById.get(source.surface.id)!,
      }),
      referenceTerminal: Object.freeze({
        part: conductor,
        surface: surfaceById.get(reference.surface.id)!,
      }),
      conductivity: isotropicIdentityTensorValue(
        rawConductor.material.variables['electrical.conductivity'],
        'Conductor Material electrical.conductivity',
        'S.m-1',
      ),
      gridShape: Object.freeze([...gridShape]) as unknown as readonly [number, number, number],
      sourceVoltage: parameterNumber(sourceRule.parameters.voltage, 'dc.source-potential voltage'),
      referenceVoltage: parameterNumber(referenceRule.parameters.voltage, 'dc.reference-potential voltage'),
      relativeTolerance: parameterNumber(config.parameters.relativeTolerance, 'dc-current-density relativeTolerance'),
      maxIterations: parameterNumber(config.parameters.maxIterations, 'dc-current-density maxIterations'),
      outputs: Object.freeze(
        config.outputs.map((output) =>
          output.methodId === 'dc.joule-heating'
            ? Object.freeze({
                key: output.key,
                methodId: output.methodId,
              })
            : Object.freeze({
                key: output.key,
                methodId: output.methodId,
                crossSectionPosition: parameterNumber(
                  output.parameters.crossSectionPosition,
                  `${output.methodId} crossSectionPosition`,
                ),
              }),
        ),
      ),
    }),
  })
}
