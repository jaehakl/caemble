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
  savedSimulationCode,
  selectedId,
  simulationCode,
  values,
}: {
  document: CadSourceDocument
  forceRoot?: boolean
  kind: CadDocumentType
  savedCode: string | null
  savedSimulationCode?: string | null
  selectedId: number | null
  simulationCode?: string | null
  values: DefinitionFormValues
}): Promise<SaveCodeEntityResponse & { code: string; kind: CadDocumentType; simulationCode?: string }> {
  if (!forceRoot && selectedId && savedCode === null) throw new Error('저장 기준 source를 찾을 수 없습니다.')
  if (kind === 'experiment' && !simulationCode?.trim()) {
    throw new Error('Python simulate source가 필요합니다.')
  }
  if (kind === 'experiment' && !forceRoot && selectedId && savedSimulationCode === null) {
    throw new Error('Python source가 없는 기존 Experiment는 수정할 수 없습니다. 새 root로 저장하세요.')
  }

  const code = cadSource(document)
  const activeId = forceRoot ? null : selectedId
  const baseCode = forceRoot ? null : savedCode
  const pythonSource = kind === 'experiment' ? simulationCode! : null
  const basePythonSource = forceRoot || kind === 'structure' ? null : savedSimulationCode

  if (baseCode === code && basePythonSource === pythonSource) {
    const unchangedHash = await rawCodeHash(code)
    const simulationRawCodeHash = pythonSource === null ? null : await rawCodeHash(pythonSource)
    const payload = {
      ...(activeId ? { id: activeId } : {}),
      name: values.name,
      description: values.description || null,
      code,
      rawCodeHash: unchangedHash,
      semanticHash: unchangedHash,
      semanticHashVersion: 1 as const,
      ...(activeId ? { baseRawCodeHash: unchangedHash } : {}),
      ...(simulationRawCodeHash
        ? {
            simulationCode: pythonSource!,
            simulationRawCodeHash,
            ...(activeId ? { baseSimulationRawCodeHash: simulationRawCodeHash } : {}),
          }
        : {}),
    }
    const result =
      kind === 'structure'
        ? await dbTables.Structure.save(payload)
        : await dbTables.Experiment.save({
            ...payload,
            simulationCode: pythonSource!,
            simulationRawCodeHash: simulationRawCodeHash!,
          })
    return { ...result, code, kind, ...(pythonSource === null ? {} : { simulationCode: pythonSource }) }
  }

  const baseDocument =
    baseCode === null ? null : createCadSourceDocument(kind, baseCode, document.realizationSeed, basePythonSource)
  const [nextRawHash, semanticHash, baseRawHash, baseSemanticHash, simulationRawCodeHash, baseSimulationRawCodeHash] =
    await Promise.all([
      rawCodeHash(code),
      cadSemanticHash(document),
      baseCode === null ? Promise.resolve(undefined) : rawCodeHash(baseCode),
      baseDocument === null ? Promise.resolve(undefined) : cadSemanticHash(baseDocument),
      pythonSource === null ? Promise.resolve(undefined) : rawCodeHash(pythonSource),
      basePythonSource == null ? Promise.resolve(undefined) : rawCodeHash(basePythonSource),
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
    ...(simulationRawCodeHash
      ? {
          simulationCode: pythonSource!,
          simulationRawCodeHash,
          ...(baseSimulationRawCodeHash ? { baseSimulationRawCodeHash } : {}),
        }
      : {}),
  }
  const result =
    kind === 'structure'
      ? await dbTables.Structure.save(payload)
      : await dbTables.Experiment.save({
          ...payload,
          simulationCode: pythonSource!,
          simulationRawCodeHash: simulationRawCodeHash!,
        })
  return { ...result, code, kind, ...(pythonSource === null ? {} : { simulationCode: pythonSource }) }
}
