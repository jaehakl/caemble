import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { ExperimentSourceBundle } from '@/contracts/cad-persistence'
import type { MeasurementMaterialParameters } from '@/contracts/api/measurement'
import type {
  MaterialNameRecord,
  MaterialRecord,
  MaterialParameterRecord,
  MaterialParameterQualifierRecord,
} from '@/contracts/api/materials'
import { canonicalGeometryScene } from '@/lib/cad/evaluation/canonical'
import { buildMeasurement } from '@/lib/cad/execution/measurement'
import { executeCompiledDocument, inspectCompiledDocument } from '@/lib/cad/execution/userModule'
import type { CompiledCadDocument } from '@/lib/cad/compiler/types'
import { generateRandomVars } from '@/lib/cad/model/vars'
import type { Vars } from '@/lib/cad/model/types'
import { assertExperimentAuthoringSemantics } from '@/lib/cad/simulation/authoringSemantics'
import { resolveMaterialParameters, projectMaterialResolution } from '@/lib/material/resolution'

export type CaePreparationRequest = Readonly<{
  source_bundle: ExperimentSourceBundle
  source_hash: string
  catalog: CatalogRuntimeSlice
  mode: 'generate' | 'candidate' | 'measurement'
  vars_mode?: 'random' | 'nominal'
  vars?: Readonly<Vars>
  material_parameters?: MeasurementMaterialParameters
  materials: Readonly<{
    names: readonly MaterialNameRecord[]
    materials: readonly MaterialRecord[]
    parameters: readonly MaterialParameterRecord[]
    qualifiers: readonly MaterialParameterQualifierRecord[]
  }>
  evaluation_timeout_ms?: number
}>

export function evaluateBuildInput(request: CaePreparationRequest, compiled: CompiledCadDocument) {
  if (!['generate', 'candidate', 'measurement'].includes(request.mode)) throw new Error('Unknown build mode.')
  if (request.mode !== 'generate' && (!request.vars || !request.material_parameters)) {
    throw new Error('A fixed Candidate or Measurement requires Vars and a frozen Material snapshot.')
  }
  const { varsSchema } = inspectCompiledDocument(compiled)
  const nominalTensor = (shape: readonly number[], value: number): import('../cad/model/types').Tensor =>
    shape.length ? Array.from({ length: shape[0] }, () => nominalTensor(shape.slice(1), value)) : value
  const vars =
    request.vars ??
    (request.vars_mode === 'nominal'
      ? Object.fromEntries(
          Object.entries(varsSchema).map(([key, entry]) => [
            key,
            nominalTensor(entry.shape, (entry.min + entry.max) / 2),
          ]),
        )
      : generateRandomVars(varsSchema))
  return executeCompiledDocument(compiled, vars, request.source_bundle.files['simulate.py'])
}

export async function buildEvaluatedMeasurement(
  request: CaePreparationRequest,
  evaluated: ReturnType<typeof executeCompiledDocument>,
) {
  assertExperimentAuthoringSemantics(request.catalog, evaluated)
  const taskNames = Object.keys(evaluated.taskScenes).sort()
  const commonMaterials = evaluated.scene.parts.flatMap((part) => (part.material ? [part.material] : []))
  const taskMaterials = Object.fromEntries(
    taskNames.map((name) => [
      name,
      evaluated.taskScenes[name].parts.flatMap((part) => (part.material ? [part.material] : [])),
    ]),
  )
  const frozen = request.mode === 'generate' ? undefined : request.material_parameters
  if (
    frozen &&
    (taskNames.some((name) => !frozen.tasks[name]) || Object.keys(frozen.tasks).length !== taskNames.length)
  ) {
    throw new Error('Frozen Material snapshot must match the Experiment tasks.')
  }
  // One resolution across common and task scenes gives every reference the same
  // sampled Material values. Projection never samples again.
  const shared = frozen
    ? undefined
    : resolveMaterialParameters(
        [...commonMaterials, ...taskNames.flatMap((name) => taskMaterials[name])],
        request.materials.names,
        request.materials.parameters,
        { materials: request.materials.materials, qualifiers: request.materials.qualifiers },
      )
  const common = frozen
    ? { materialParameters: frozen.experiment, warnings: [] }
    : projectMaterialResolution(shared!, commonMaterials)
  const tasks = Object.fromEntries(
    taskNames.map((name) => [
      name,
      frozen
        ? { materialParameters: frozen.tasks[name], warnings: [] }
        : projectMaterialResolution(shared!, taskMaterials[name]),
    ]),
  )
  const scene = await canonicalGeometryScene(evaluated.scene)
  const taskScenes = Object.fromEntries(
    await Promise.all(taskNames.map(async (name) => [name, await canonicalGeometryScene(evaluated.taskScenes[name])])),
  )
  const measurement = buildMeasurement(
    { ...evaluated, scene, taskScenes },
    {
      materialParameters: common.materialParameters,
      warnings: common.warnings,
      taskMaterialParameters: Object.fromEntries(taskNames.map((name) => [name, tasks[name].materialParameters])),
      taskMaterialWarnings: Object.fromEntries(taskNames.map((name) => [name, tasks[name].warnings])),
    },
  )
  const presentation = (scene: typeof evaluated.scene) => ({
    tree: scene.tree,
    materials: scene.parts.map(({ id, material }) => ({ id, material })),
  })
  return {
    measurement,
    presentation: {
      experiment: presentation(evaluated.scene),
      tasks: Object.fromEntries(taskNames.map((name) => [name, presentation(evaluated.taskScenes[name])])),
    },
    vars: evaluated.variables,
    material_parameters: { experiment: measurement.materialParameters, tasks: measurement.taskMaterialParameters },
    warnings: [...new Set([...common.warnings, ...taskNames.flatMap((name) => tasks[name].warnings)])],
  }
}
