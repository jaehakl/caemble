import { runInNewContext } from 'node:vm'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { evaluateBuildInput, buildEvaluatedMeasurement, type CaePreparationRequest } from '@/lib/cae/build'
import { compileNodeCadDocument } from './cadCompiler'
export type { CaePreparationRequest } from '@/lib/cae/build'

export async function prepareCaeMeasurement(request: CaePreparationRequest, declarationsDirectory?: string) {
  installCatalogRuntimeSlice(request.catalog)
  const compiled = compileNodeCadDocument(
    request.source_bundle.files,
    request.source_hash,
    request.catalog,
    declarationsDirectory,
  )
  const timeout = request.evaluation_timeout_ms ?? 3000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error('Invalid evaluation timeout.')
  const evaluated: ReturnType<typeof evaluateBuildInput> = runInNewContext(
    'evaluate()',
    {
      evaluate: () => evaluateBuildInput(request, compiled),
    },
    { timeout },
  )
  return buildEvaluatedMeasurement(request, evaluated)
}
