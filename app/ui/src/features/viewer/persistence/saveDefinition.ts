import { dbTables, type SaveCodeEntityResponse } from '@/api'
import {
  cadSource,
  cadSemanticHash,
  createCadSourceDocument,
  rawCodeHash,
  type CadDocumentType,
  type CadSourceDocument,
} from '@/lib/cad'
import type { DefinitionFormValues } from './SaveDefinitionDialog'

export async function saveCadDefinition({
  document,
  forceRoot = false,
  kind,
  savedCode,
  selectedId,
  values,
}: {
  document: CadSourceDocument
  forceRoot?: boolean
  kind: CadDocumentType
  savedCode: string | null
  selectedId: number | null
  values: DefinitionFormValues
}): Promise<SaveCodeEntityResponse & { code: string; kind: CadDocumentType }> {
  if (!forceRoot && selectedId && savedCode === null) throw new Error('저장 기준 source를 찾을 수 없습니다.')

  const code = cadSource(document)
  const activeId = forceRoot ? null : selectedId
  const baseCode = forceRoot ? null : savedCode

  if (baseCode === code) {
    const unchangedHash = await rawCodeHash(code)
    const payload = {
      ...(activeId ? { id: activeId } : {}),
      name: values.name,
      description: values.description || null,
      code,
      rawCodeHash: unchangedHash,
      semanticHash: unchangedHash,
      semanticHashVersion: 1 as const,
      ...(activeId ? { baseRawCodeHash: unchangedHash } : {}),
    }
    const result =
      kind === 'structure' ? await dbTables.Structure.save(payload) : await dbTables.Experiment.save(payload)
    return { ...result, code, kind }
  }

  const baseDocument = baseCode === null ? null : createCadSourceDocument(kind, baseCode, document.realizationSeed)
  const [nextRawHash, semanticHash, baseRawHash, baseSemanticHash] = await Promise.all([
    rawCodeHash(code),
    cadSemanticHash(document),
    baseCode === null ? Promise.resolve(undefined) : rawCodeHash(baseCode),
    baseDocument === null ? Promise.resolve(undefined) : cadSemanticHash(baseDocument),
  ])
  const payload = {
    ...(activeId ? { id: activeId } : {}),
    name: values.name,
    description: values.description || null,
    code,
    rawCodeHash: nextRawHash,
    semanticHash,
    semanticHashVersion: 1 as const,
    ...(baseRawHash ? { baseRawCodeHash: baseRawHash } : {}),
    ...(baseSemanticHash ? { baseSemanticHash } : {}),
  }
  const result = kind === 'structure' ? await dbTables.Structure.save(payload) : await dbTables.Experiment.save(payload)
  return { ...result, code, kind }
}
