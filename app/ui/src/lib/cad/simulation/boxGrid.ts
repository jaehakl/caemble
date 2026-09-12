import { assertBoxGridData, type BoxGridData, type BoxGridGeometry, type BoxGridVector } from '@/contracts/boxGrid'
import { activeCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { canonicalGeometrySceneDraft } from '../evaluation/canonical'
import type { CanonicalGeometrySceneDraftV1 } from '../evaluation/canonicalTypes'
import type { CadScene } from '../evaluation/types'
import { CadModelError } from '../model/errors'
import { convertUcumValue } from '../model/units'
import type { KernelTaskConfig, KernelOutputRequest } from './kernelContract'
import type { SimulationProgramManifest } from './types'
import { projectArtifactRecordingSchema } from './outputRecording'
import { canonicalRecordedDataTree } from './authoring'

export function resolveBoxGridGeometry(
  output: KernelOutputRequest,
  scenes: Readonly<{ experiment: CanonicalGeometrySceneDraftV1; task: CanonicalGeometrySceneDraftV1 }>,
  lengthUnit: string,
): BoxGridGeometry {
  const match = output.target.length === 1 ? /^(experiment|task)\.geometry\.(.+)$/u.exec(output.target[0]) : null
  if (!match) throw new CadModelError(`Output ${output.key} requires exactly one Experiment or Task Box target.`)
  const source = match[1] as 'experiment' | 'task'
  const scene = scenes[source]
  const group = scene.geometryGroups.find((candidate) => candidate.name === match[2])
  if (!group || group.rootIds.length !== 1 || group.missingMemberIds.length)
    throw new CadModelError(`Output ${output.key} target must resolve to exactly one Box.`)
  const root = scene.roots.find((candidate) => candidate.id === group.rootIds[0])!
  let node = root.node
  let matrix: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  while (node.kind === 'transform' || node.kind === 'instance') {
    const right = node.matrix
    const product = Array<number>(16).fill(0)
    for (let column = 0; column < 4; column += 1)
      for (let row = 0; row < 4; row += 1)
        for (let inner = 0; inner < 4; inner += 1)
          product[row * 4 + column] += matrix[row * 4 + inner] * right[inner * 4 + column]
    matrix = product
    node = node.child
  }
  if (node.kind !== 'primitive' || node.primitive !== 'box')
    throw new CadModelError(
      `Output ${output.key} requires a Box primitive; Boolean and shell results are not Box targets.`,
    )
  const parameter = output.parameters.gridShape
  const gridShape = Array.isArray(parameter)
    ? parameter
    : parameter && typeof parameter === 'object' && 'value' in parameter
      ? parameter.value
      : undefined
  if (
    !Array.isArray(gridShape) ||
    gridShape.length !== 3 ||
    gridShape.some((size) => !Number.isSafeInteger(size) || size < 1)
  )
    throw new CadModelError(`Output ${output.key} requires parameters.gridShape=[nx,ny,nz] with positive integers.`)
  const primitiveSize = node.parameters.size as readonly number[]
  const scales = [0, 1, 2].map((column) => Math.hypot(matrix[column], matrix[4 + column], matrix[8 + column]))
  const factor = convertUcumValue(1, scene.lengthUnit, lengthUnit)
  const size = primitiveSize.map((value, axis) => value * scales[axis] * factor) as unknown as BoxGridVector
  const rotation = [0, 1, 2].map((row) =>
    [0, 1, 2].map((column) => matrix[row * 4 + column] / scales[column]),
  ) as unknown as BoxGridGeometry['rotation']
  const origin = [0, 1, 2].map(
    (row) =>
      matrix[row * 4 + 3] * factor - rotation[row].reduce((sum, value, column) => sum + (value * size[column]) / 2, 0),
  ) as unknown as BoxGridVector
  for (let row = 0; row < 3; row += 1) {
    for (let other = 0; other < 3; other += 1) {
      const dot = rotation[row].reduce((sum, value, column) => sum + value * rotation[other][column], 0)
      if (!Number.isFinite(dot) || Math.abs(dot - Number(row === other)) > 1e-8)
        throw new CadModelError(`Output ${output.key} Box transform must be orthogonal; shear is not supported.`)
    }
  }
  return {
    origin,
    size,
    rotation,
    lengthUnit,
    gridShape: gridShape as unknown as BoxGridGeometry['gridShape'],
    source,
    rootId: root.id,
  }
}

export function resolveProgramBoxGrids(
  program: SimulationProgramManifest,
  scene: CadScene,
  taskScenes: Readonly<Record<string, CadScene>>,
): SimulationProgramManifest {
  const catalog = activeCatalogRuntimeSlice()
  const grids = new Map<string, BoxGridData>()
  const visualizationContracts: Record<
    string,
    NonNullable<SimulationProgramManifest['visualizationContracts']>[string]
  > = {}
  const tasks = Object.fromEntries(
    Object.entries(program.tasks).map(([name, task]) => {
      const config = task.config as KernelTaskConfig
      const descriptor = catalog.solvers.find(
        (solver) => solver.name === task.kernel.name && solver.version === task.kernel.version,
      )?.descriptor
      if (!descriptor) return [name, task]
      visualizationContracts[name] = Object.fromEntries(
        Object.entries(descriptor.visualizations ?? {}).map(([key, contract]) => {
          if (!contract.data.visualization)
            throw new CadModelError(`Visualization ${name}.${key} has no semantic contract.`)
          return [
            key,
            {
              artifactType: contract.artifactType,
              visualization: contract.data.visualization,
              schema: canonicalRecordedDataTree({
                [key]: projectArtifactRecordingSchema(contract.data, descriptor.referenceLengthUnit),
              })[key],
            },
          ]
        }),
      )
      const outputs = config.outputs.map((output) => {
        const method = descriptor.methods.outputs.find((item) => item.methodId === output.methodId)
        if (!method || !('boxGrid' in method.data) || !method.data.boxGrid)
          throw new CadModelError(`Output ${name}.${output.key} has no Box Grid contract.`)
        const geometry = resolveBoxGridGeometry(
          output,
          {
            experiment: canonicalGeometrySceneDraft(scene),
            task: canonicalGeometrySceneDraft(taskScenes[name]),
          },
          descriptor.referenceLengthUnit,
        )
        const data = { ...method.data.boxGrid, ...geometry }
        assertBoxGridData(data)
        grids.set(`${name}.${output.key}`, data)
        return { ...output, boxGrid: geometry }
      })
      const keys = [...outputs, ...(config.exports ?? [])].map((output) => output.key)
      if (new Set(keys).size !== keys.length)
        throw new CadModelError(`Task ${name} Outputs and exports must have unique keys.`)
      return [name, { ...task, config: { ...config, outputs } }]
    }),
  )
  const boxGrids = Object.fromEntries(
    Object.entries(program.resultContracts).map(([name, contract]) => {
      const grid = grids.get(`${contract.task}.${contract.output}`)
      if (!grid) throw new CadModelError(`RecordedData ${name} must reference a Box Grid Output.`)
      return [name, grid]
    }),
  )
  return Object.freeze({ ...program, tasks, boxGrids, visualizationContracts })
}
