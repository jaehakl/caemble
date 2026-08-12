import { dbTables, type SaveCodeEntityResponse } from '@/api'
import { rawCodeHash, type CadSourceDocument, type ExperimentSourceBundle } from '@/lib/cad'
import type { DefinitionFormValues } from './SaveDefinitionDialog'

function canonicalBundle(bundle: ExperimentSourceBundle) {
  return JSON.stringify({
    files: Object.fromEntries(Object.entries(bundle.files).sort(([left], [right]) => left.localeCompare(right))),
    formatVersion: bundle.formatVersion,
  })
}

export async function experimentSourceBundleHash(bundle: ExperimentSourceBundle) {
  return rawCodeHash(canonicalBundle(bundle))
}

export async function saveCadDefinition({
  document,
  forceRoot = false,
  savedSourceBundle,
  selectedId,
  values,
}: {
  document: CadSourceDocument
  forceRoot?: boolean
  savedSourceBundle?: ExperimentSourceBundle | null
  selectedId: number | null
  values: DefinitionFormValues
}): Promise<
  SaveCodeEntityResponse & {
    sourceBundle: ExperimentSourceBundle
  }
> {
  const activeId = forceRoot ? null : selectedId
  if (!forceRoot && selectedId && !savedSourceBundle) throw new Error('저장 기준 source bundle을 찾을 수 없습니다.')
  const sourceBundle = document.sourceBundle
  const baseBundle = forceRoot ? null : (savedSourceBundle ?? null)
  const [bundleHash, baseBundleHash] = await Promise.all([
    experimentSourceBundleHash(sourceBundle),
    baseBundle === null ? Promise.resolve(undefined) : experimentSourceBundleHash(baseBundle),
  ])
  const result = await dbTables.Experiment.save({
    ...(activeId ? { id: activeId } : {}),
    name: values.name,
    description: values.description || null,
    sourceBundle,
    bundleHash,
    ...(baseBundleHash ? { baseBundleHash } : {}),
  })
  return { ...result, sourceBundle }
}
