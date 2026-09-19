import { assertBoxGridData, type BoxGridData, type BoxGridGeometry, type BoxGridVector } from '@/contracts/boxGrid'
import { activeCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { canonicalGeometrySceneDraft } from '../evaluation/canonical'
import type { CanonicalGeometrySceneDraftV2 } from '../evaluation/canonicalTypes'
import type { CadScene } from '../evaluation/types'
import { CadModelError } from '../model/errors'
import { convertUcumValue } from '../model/units'
import type { KernelTaskConfig, KernelOutputRequest } from './kernelContract'
import type { SimulationProgramManifest } from './types'
import { projectArtifactRecordingSchema } from './outputRecording'
import { canonicalRecordedDataTree } from './authoring'

export function resolveBoxGridGeometry(
  output: KernelOutputRequest,
  scenes: Readonly<{ experiment: CanonicalGeometrySceneDraftV2; task: CanonicalGeometrySceneDraftV2 }>,
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
    throw new CadModelError(`Output ${output.key} requires a Box primitive; Boolean results are not Box targets.`)
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
  return resolveProgramBoxGridMetadata(
    program,
    canonicalGeometrySceneDraft(scene),
    Object.fromEntries(
      Object.entries(taskScenes).map(([name, taskScene]) => [name, canonicalGeometrySceneDraft(taskScene)]),
    ),
  )
}

export function resolveProgramBoxGridMetadata(
  program: SimulationProgramManifest,
  scene: CanonicalGeometrySceneDraftV2,
  taskScenes: Readonly<Record<string, CanonicalGeometrySceneDraftV2>>,
  records?: readonly string[],
): SimulationProgramManifest {
  const required =
    records === undefined
      ? undefined
      : new Set(
          records.flatMap((name) => {
            const contract = program.resultContracts[name]
            if (!contract) throw new CadModelError(`RecordedData ${name} has no Output contract.`)
            return [`${contract.task}.${contract.output}`]
          }),
        )
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
        if (required && !required.has(`${name}.${output.key}`)) return output
        const method = descriptor.methods.outputs.find((item) => item.methodId === output.methodId)
        if (!method || !('boxGrid' in method.data) || !method.data.boxGrid)
          throw new CadModelError(`Output ${name}.${output.key} has no Box Grid contract.`)
        const geometry = resolveBoxGridGeometry(
          output,
          {
            experiment: scene,
            task: taskScenes[name],
          },
          descriptor.referenceLengthUnit,
        )
        const data = { ...method.data.boxGrid, ...geometry }
        assertBoxGridData(data)
        if (method.data.boxGrid.sampling === 'surface-integral') validateDetectorBox(output, geometry, scene, config)
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
    Object.entries(program.resultContracts)
      .filter(([name]) => records === undefined || records.includes(name))
      .map(([name, contract]) => {
        const grid = grids.get(`${contract.task}.${contract.output}`)
        if (!grid) throw new CadModelError(`RecordedData ${name} must reference a Box Grid Output.`)
        return [name, grid]
      }),
  )
  return Object.freeze({ ...program, tasks, boxGrids, visualizationContracts })
}

export function validateDetectorBox(
  output: KernelOutputRequest,
  grid: BoxGridGeometry,
  scene: CanonicalGeometrySceneDraftV2,
  config: KernelTaskConfig,
) {
  const raw = output.parameters.surface
  const reference = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
  const group =
    typeof reference === 'string' && reference.startsWith('experiment.surface.')
      ? scene.surfaceGroups.find((group) => `experiment.surface.${group.name}` === reference)
      : undefined
  if (!group || group.selectors.length !== 1 || group.missingMemberIds.length)
    throw new CadModelError(`Output ${output.key} requires one detector surface.`)
  const selected = group.selectors[0]
  const sameSurface = (other: typeof selected) =>
    other.rootId === selected.rootId &&
    other.sourceNodeId === selected.sourceNodeId &&
    other.surfaceIndex === selected.surfaceIndex
  const absorbing = config.boundaryConditions.some(
    (rule) =>
      rule.methodId === 'ray.absorbing-detector' &&
      rule.target.some((target) =>
        scene.surfaceGroups.find((group) => `experiment.surface.${group.name}` === target)?.selectors.some(sameSurface),
      ),
  )
  const inDomain = config.initializations.some(
    (rule) =>
      rule.methodId === 'ray.domain' &&
      rule.target.some((target) =>
        scene.geometryGroups
          .find((group) => `experiment.geometry.${group.name}` === target)
          ?.rootIds.includes(selected.rootId),
      ),
  )
  if (!absorbing || !inDomain)
    throw new CadModelError(`Output ${output.key} requires an absorbing detector in ray.domain.`)
  const root = scene.roots.find((root) => root.id === selected.rootId)!
  let node = root.node
  while (node.kind === 'transform' || node.kind === 'instance') node = node.child
  if (node.kind !== 'primitive' || node.primitive !== 'box' || node.nodeId !== selected.sourceNodeId)
    throw new CadModelError(`Output ${output.key} requires an uncut Box face.`)
  const bodyScene = {
    ...scene,
    geometryGroups: [
      {
        id: 'detector-body',
        name: 'detector-body',
        kind: 'geometry' as const,
        memberIds: [root.id],
        rootIds: [root.id],
        missingMemberIds: [],
      },
    ],
  }
  const body = resolveBoxGridGeometry(
    { ...output, target: ['experiment.geometry.detector-body'], parameters: { gridShape: [1, 1, 1] } },
    { experiment: bodyScene, task: bodyScene },
    grid.lengthUnit,
  )
  const normal = Math.floor(selected.surfaceIndex / 2),
    high = selected.surfaceIndex % 2
  const tangents = [0, 1, 2].filter((axis) => axis !== normal)
  const corners = [0, 1, 2, 3].map((index) => {
    const local = [0, 0, 0]
    local[normal] = high * body.size[normal]
    local[tangents[0]] = (index >> 1) * body.size[tangents[0]]
    local[tangents[1]] = (index & 1) * body.size[tangents[1]]
    const world = body.origin.map(
      (origin, row) => origin + body.rotation[row].reduce((sum, value, column) => sum + value * local[column], 0),
    )
    return [0, 1, 2].map((column) =>
      world.reduce((sum, value, row) => sum + (value - grid.origin[row]) * grid.rotation[row][column], 0),
    )
  })
  const tolerance =
    128 *
    Number.EPSILON *
    Math.max(...body.size, ...body.origin.map(Math.abs), ...grid.size, ...grid.origin.map(Math.abs))
  for (const [u, v] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ]) {
    if (
      !corners.some(
        (corner) =>
          Math.hypot(corner[0] - u * grid.size[0], corner[1] - v * grid.size[1], corner[2] - grid.size[2] / 2) <=
          tolerance,
      )
    )
      throw new CadModelError(`Output ${output.key} Box must cover the full detector face at its z-cell center.`)
  }
}
