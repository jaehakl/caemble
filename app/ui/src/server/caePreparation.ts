import { runInNewContext } from 'node:vm'
import type { CatalogRuntimeSlice } from '../contracts/catalog'
import type { ExperimentSourceBundle } from '../contracts/cad-persistence'
import type { MeasurementMaterialParameters } from '../contracts/api/measurement'
import type {
  MaterialNameRecord,
  MaterialRecord,
  MaterialParameterRecord,
  MaterialParameterQualifierRecord,
} from '../contracts/api/materials'
import { installCatalogRuntimeSlice } from '../lib/catalog/runtime'
import { canonicalGeometryScene } from '../lib/cad/evaluation/canonical'
import { buildMeasurement } from '../lib/cad/execution/measurement'
import { executeCompiledDocument, inspectCompiledDocument } from '../lib/cad/execution/userModule'
import { generateRandomVars } from '../lib/cad/model/vars'
import type { Vars } from '../lib/cad/model/types'
import { assertExperimentAuthoringSemantics } from '../lib/cad/simulation/authoringSemantics'
import { resolveMaterialParameters, projectMaterialResolution } from '../lib/material/resolution'
import { compileServerCadDocument } from './cadCompiler'

export type CaePreparationRequest = Readonly<{
  source_bundle: ExperimentSourceBundle
  source_hash: string
  catalog: CatalogRuntimeSlice
  mode: 'generate' | 'candidate' | 'measurement'
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

export async function prepareCaeMeasurement(request: CaePreparationRequest, declarationsDirectory?: string) {
  installCatalogRuntimeSlice(request.catalog)
  const compiled = compileServerCadDocument(
    request.source_bundle.files,
    request.source_hash,
    request.catalog,
    declarationsDirectory,
  )
  if (!['generate', 'candidate', 'measurement'].includes(request.mode)) throw new Error('Unknown CAE preparation mode.')
  if (request.mode !== 'generate' && (!request.vars || !request.material_parameters)) {
    throw new Error('A fixed Candidate or Measurement requires Vars and a frozen Material snapshot.')
  }
  const timeout = request.evaluation_timeout_ms ?? 3000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error('Invalid evaluation timeout.')
  // This VM timeout bounds synchronous authored code. Process isolation and the
  // API child timeout additionally bound compilation and canonical serialization.
  const evaluated: ReturnType<typeof executeCompiledDocument> = runInNewContext(
    'evaluate()',
    {
      evaluate: () => {
        const { varsSchema } = inspectCompiledDocument(compiled)
        const vars = request.mode === 'generate' ? generateRandomVars(varsSchema) : request.vars!
        return executeCompiledDocument(compiled, vars, request.source_bundle.files['simulate.py'])
      },
    },
    { timeout },
  )
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
  return {
    measurement,
    vars: evaluated.variables,
    material_parameters: { experiment: measurement.materialParameters, tasks: measurement.taskMaterialParameters },
    warnings: [...new Set([...common.warnings, ...taskNames.flatMap((name) => tasks[name].warnings)])],
  }
}
