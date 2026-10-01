import type { PredictionModelRecord, PredictionReplica, PredictionStorage } from '@/contracts/api/prediction'
import type { PredictionAssetsSnapshot } from './assetManagement'

export type ModelFileRow = Readonly<{
  key: string
  model: PredictionModelRecord
  revision: PredictionModelRecord['revisions'][number]
  replica?: PredictionReplica
  storage?: PredictionStorage
  launcherIds: readonly string[]
  launcherNames: string
  files: readonly { name: string; byteLength: number | null; sha256: string | null }[]
  bytes: number | null
}>

export function modelFileRows(state: PredictionAssetsSnapshot): ModelFileRow[] {
  return state.models
    .filter((model) => model.state !== 'deleted')
    .flatMap((model) =>
      model.revisions.flatMap((revision) => {
        const copies = revision.replicas.filter((copy) => copy.state !== 'deleted')
        return (copies.length ? copies : [undefined]).map((replica) => {
          const storage = state.storages.find((item) => item.storage_id === replica?.storage_id)
          const launcherIds = [...new Set(storage?.accesses.map((access) => access.launcher_id) ?? [])]
          const raw = replica?.artifact?.files ?? revision.artifact?.files
          const files = (Array.isArray(raw) ? raw : []).flatMap((file: unknown) => {
            if (!file || typeof file !== 'object' || !('name' in file) || typeof file.name !== 'string') return []
            return [
              {
                name: file.name,
                byteLength:
                  'byteLength' in file &&
                  typeof file.byteLength === 'number' &&
                  Number.isSafeInteger(file.byteLength) &&
                  file.byteLength >= 0
                    ? file.byteLength
                    : null,
                sha256: 'sha256' in file && typeof file.sha256 === 'string' ? file.sha256 : null,
              },
            ]
          })
          return {
            key: replica?.id ?? `${model.id}:${revision.revision}:empty`,
            model,
            revision,
            replica,
            storage,
            launcherIds,
            launcherNames: launcherIds
              .map((id) => state.launchers.find((launcher) => launcher.id === id)?.launcher_name ?? '등록된 장비')
              .sort()
              .join(', '),
            files,
            bytes:
              replica && files.length && files.every((file) => file.byteLength !== null)
                ? files.reduce((sum, file) => sum + file.byteLength!, 0)
                : null,
          }
        })
      }),
    )
}

export function visibleModelFiles(rows: readonly ModelFileRow[], params: URLSearchParams) {
  const search = (params.get('q') ?? '').trim().toLocaleLowerCase()
  const filtered = rows.filter((row) => {
    const fields: Record<string, string> = {
      experiment: String(row.model.experiment_id),
      model: row.model.id,
      revision: String(row.revision.revision),
      kind: row.storage?.kind ?? 'none',
      state: row.replica?.state ?? 'none',
    }
    return (
      row.model.name.toLocaleLowerCase().includes(search) &&
      Object.entries(fields).every(([key, value]) => !params.get(key) || params.get(key) === value) &&
      (!params.get('launcher') || row.launcherIds.includes(params.get('launcher')!))
    )
  })
  const order = params.get('order') === 'desc' ? -1 : 1
  return filtered.sort((a, b) => {
    let compared = 0
    switch (params.get('sort')) {
      case 'name':
        compared = a.model.name.localeCompare(b.model.name)
        break
      case 'launcher':
        compared = a.launcherNames.localeCompare(b.launcherNames)
        break
      case 'revision':
        compared = a.revision.revision - b.revision.revision
        break
      case 'bytes':
        if (a.bytes === null || b.bytes === null)
          return a.bytes === b.bytes ? a.key.localeCompare(b.key) : a.bytes === null ? 1 : -1
        compared = a.bytes - b.bytes
        break
      case 'checked':
        if (!a.replica?.checked_at || !b.replica?.checked_at)
          return a.replica?.checked_at === b.replica?.checked_at
            ? a.key.localeCompare(b.key)
            : !a.replica?.checked_at
              ? 1
              : -1
        compared = Date.parse(a.replica.checked_at) - Date.parse(b.replica.checked_at)
        break
    }
    return (
      compared * order ||
      a.model.name.localeCompare(b.model.name) ||
      b.revision.revision - a.revision.revision ||
      (a.storage?.name ?? '').localeCompare(b.storage?.name ?? '') ||
      a.key.localeCompare(b.key)
    )
  })
}

export function modelFileActionReason(row: ModelFileRow, action: 'verify' | 'remove'): string | null {
  if (!row.replica) return '복사본 없음'
  if (row.replica.state === 'deleting') return '기존 삭제 작업에서 계속하세요'
  if (row.model.state !== 'active') return '모델 전체 삭제 진행 중'
  if (action === 'verify') {
    if (row.storage?.kind !== 'predictor_local') return '백업은 복원할 때 파일을 검증합니다'
    if (!row.storage.accesses.some((access) => access.connected)) return '장비 오프라인'
  }
  return null
}

export function modelRemovalSummary(rows: readonly ModelFileRow[], selected: readonly ModelFileRow[]) {
  const keys = new Set(selected.map((row) => row.key))
  const revisions = new Map(selected.map((row) => [`${row.model.id}:${row.revision.revision}`, row]))
  return [...revisions.values()]
    .map((row) => {
      const remaining = rows.filter(
        (item) =>
          item.model.id === row.model.id &&
          item.revision.revision === row.revision.revision &&
          item.replica?.state === 'present' &&
          !keys.has(item.key),
      ).length
      return `${row.model.name} r${row.revision.revision}: 제거 후 다른 검증된 복사본 ${remaining}개${remaining ? '' : ' · 마지막 복사본일 수 있음'}`
    })
    .join('\n')
}
