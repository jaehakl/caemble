import { dbTables, type ExperimentRecordContract, type SaveExperimentResponse } from '@/api'
import { rawCodeHash } from '@/lib/cad/compiler/semanticHash'
import type { CadSourceDocument, ExperimentSourceBundle } from '@/lib/cad/source'
import type { DefinitionFormValues, ExperimentSaveMode } from './SaveDefinitionDialog'

function canonicalBundle(bundle: ExperimentSourceBundle) {
  const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  const value = {
    files: Object.fromEntries(Object.entries(bundle.files).sort(([left], [right]) => compareText(left, right))),
  }
  const stable = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(stable)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => compareText(left, right))
              .map(([key, child]) => [key, stable(child)]),
          )
        : item
  return JSON.stringify(stable(value))
}

export async function experimentSourceBundleHash(bundle: ExperimentSourceBundle) {
  return rawCodeHash(canonicalBundle(bundle))
}

export async function saveCadDefinition({
  document,
  mode,
  savedSourceBundle,
  selectedId,
  records,
  values,
}: {
  document: CadSourceDocument
  mode: ExperimentSaveMode
  savedSourceBundle?: ExperimentSourceBundle | null
  selectedId: number | null
  records: readonly ExperimentRecordContract[]
  values: DefinitionFormValues
}): Promise<
  SaveExperimentResponse & {
    sourceBundle: ExperimentSourceBundle
  }
> {
  if (mode !== 'create' && (!selectedId || !savedSourceBundle)) {
    throw new Error('저장 기준 Experiment source bundle을 찾을 수 없습니다.')
  }
  const sourceBundle = document.sourceBundle
  const baseBundle = mode === 'create' ? null : (savedSourceBundle ?? null)
  const [bundleHash, baseBundleHash] = await Promise.all([
    experimentSourceBundleHash(sourceBundle),
    baseBundle === null ? Promise.resolve(undefined) : experimentSourceBundleHash(baseBundle),
  ])
  const result = await dbTables.Experiment.save({
    namespace: values.namespace,
    repository: values.repository,
    key: values.key,
    ...(mode === 'create'
      ? { mode, initialVersion: '0.1.0' as const }
      : mode === 'overwrite'
        ? { mode, experimentId: selectedId!, baseBundleHash: baseBundleHash! }
        : { mode, experimentId: selectedId!, baseBundleHash: baseBundleHash!, bump: values.bump }),
    name: values.name,
    description: values.description || null,
    sourceBundle,
    bundleHash,
    records,
  })
  return { ...result, sourceBundle }
}
