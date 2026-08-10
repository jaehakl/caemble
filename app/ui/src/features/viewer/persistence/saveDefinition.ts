import { dbTables, type SaveCodeEntityResponse } from '@/api'
import {
  cadSemanticHash,
  cadSource,
  createCadSourceDocument,
  rawCodeHash,
  type CadDocumentType,
  type CadSourceDocument,
  type ExperimentSourceBundle,
} from '@/lib/cad'
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
  kind,
  savedCode,
  savedSourceBundle,
  selectedId,
  values,
}: {
  document: CadSourceDocument
  forceRoot?: boolean
  kind: CadDocumentType
  savedCode: string | null
  savedSourceBundle?: ExperimentSourceBundle | null
  selectedId: number | null
  values: DefinitionFormValues
}): Promise<
  SaveCodeEntityResponse & {
    code?: string
    kind: CadDocumentType
    sourceBundle?: ExperimentSourceBundle
  }
> {
  const activeId = forceRoot ? null : selectedId
  if (kind === 'structure') {
    if (document.kind !== 'structure') throw new Error('Structure source document가 필요합니다.')
    if (!forceRoot && selectedId && savedCode === null) throw new Error('저장 기준 source를 찾을 수 없습니다.')
    const code = cadSource(document)
    const baseCode = forceRoot ? null : savedCode
    const unchanged = baseCode === code
    const baseDocument =
      baseCode === null ? null : createCadSourceDocument('structure', baseCode, document.realizationSeed)
    const [nextRawHash, semanticHash, baseRawHash, baseSemanticHash] = await Promise.all([
      rawCodeHash(code),
      unchanged ? rawCodeHash(code) : cadSemanticHash(document),
      baseCode === null ? Promise.resolve(undefined) : rawCodeHash(baseCode),
      baseDocument === null
        ? Promise.resolve(undefined)
        : unchanged
          ? rawCodeHash(baseCode!)
          : cadSemanticHash(baseDocument),
    ])
    const result = await dbTables.Structure.save({
      ...(activeId ? { id: activeId } : {}),
      name: values.name,
      description: values.description || null,
      code,
      rawCodeHash: nextRawHash,
      semanticHash,
      semanticHashVersion: 1,
      ...(baseRawHash ? { baseRawCodeHash: baseRawHash } : {}),
      ...(baseSemanticHash ? { baseSemanticHash } : {}),
    })
    return { ...result, code, kind }
  }

  if (document.kind !== 'experiment') throw new Error('Experiment source bundle이 필요합니다.')
  if (!forceRoot && selectedId && !savedSourceBundle) throw new Error('저장 기준 source bundle을 찾을 수 없습니다.')
  const sourceBundle = document.sourceBundle
  const baseBundle = forceRoot ? null : (savedSourceBundle ?? null)
  const baseDocument =
    baseBundle === null ? null : createCadSourceDocument('experiment', baseBundle, document.realizationSeed)
  const [bundleHash, semanticHash, baseBundleHash, baseSemanticHash] = await Promise.all([
    experimentSourceBundleHash(sourceBundle),
    cadSemanticHash(document),
    baseBundle === null ? Promise.resolve(undefined) : experimentSourceBundleHash(baseBundle),
    baseDocument === null ? Promise.resolve(undefined) : cadSemanticHash(baseDocument),
  ])
  const result = await dbTables.Experiment.save({
    ...(activeId ? { id: activeId } : {}),
    name: values.name,
    description: values.description || null,
    sourceBundle,
    bundleHash,
    semanticHash,
    semanticHashVersion: 2,
    ...(baseBundleHash ? { baseBundleHash } : {}),
    ...(baseSemanticHash ? { baseSemanticHash } : {}),
  })
  return { ...result, kind, sourceBundle }
}
