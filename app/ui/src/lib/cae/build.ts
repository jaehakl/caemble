import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { ExperimentSourceBundle } from '@/contracts/cad-persistence'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import { canonicalGeometryScene } from '@/lib/cad/evaluation/canonical'
import { buildMeasurement, measurementMaterialSnapshot } from '@/lib/cad/execution/measurement'
import { executeCompiledDocument, inspectCompiledDocument } from '@/lib/cad/execution/userModule'
import type { CompiledCadDocument } from '@/lib/cad/compiler/types'
import { generateRandomVars } from '@/lib/cad/model/vars'
import type { Vars } from '@/lib/cad/model/types'
import { assertExperimentAuthoringSemantics } from '@/lib/cad/simulation/authoringSemantics'
import { resolveSceneMaterials } from '@/lib/material/document'
import { analysisGeometryProfile, type GeometryEvaluationProfile } from '@/lib/cad/evaluation/precision'

export type CaePreparationRequest = Readonly<{
  source_bundle: ExperimentSourceBundle
  source_hash: string
  catalog: CatalogRuntimeSlice
  mode: 'generate' | 'candidate' | 'measurement'
  vars_mode?: 'random' | 'nominal'
  vars?: Readonly<Vars>
  material_snapshot?: MeasurementMaterialSnapshot
  evaluation_timeout_ms?: number
  geometry_precision?: GeometryEvaluationProfile
}>

export function evaluateBuildInput(request: CaePreparationRequest, compiled: CompiledCadDocument) {
  if (!['generate', 'candidate', 'measurement'].includes(request.mode)) throw new Error('Unknown build mode.')
  if (request.mode === 'candidate' && !request.vars) throw new Error('A Candidate requires Vars.')
  if (request.mode === 'measurement' && (!request.vars || !request.material_snapshot))
    throw new Error('A Measurement requires saved Vars and a Material snapshot.')
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
  return executeCompiledDocument(
    compiled,
    vars,
    request.source_bundle.files['simulate.py'],
    request.geometry_precision ?? analysisGeometryProfile,
  )
}

export async function buildEvaluatedMeasurement(
  request: CaePreparationRequest,
  evaluated: ReturnType<typeof executeCompiledDocument>,
) {
  assertExperimentAuthoringSemantics(request.catalog, evaluated)
  const taskNames = Object.keys(evaluated.taskScenes).sort()
  const resolution = resolveSceneMaterials(
    evaluated,
    request.mode === 'measurement' ? (request.material_snapshot ?? null) : null,
    request.catalog,
  )
  const scene = await canonicalGeometryScene(evaluated.scene)
  const taskScenes = Object.fromEntries(
    await Promise.all(taskNames.map(async (name) => [name, await canonicalGeometryScene(evaluated.taskScenes[name])])),
  )
  const measurement = buildMeasurement({ ...evaluated, scene, taskScenes }, resolution)
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
    material_snapshot: measurementMaterialSnapshot(measurement),
    warnings: [],
  }
}
