import type {
  PredictionDatasetRecord,
  PredictionModelRecord,
  PredictionReplica,
  PredictionStorage,
} from '@/contracts/api/prediction'
import type { PredictionAssetsSnapshot } from './assetManagement'
import { datasetTrainingReason } from './datasetManagement'

type AssetRevision =
  | Readonly<{ kind: 'model'; asset: PredictionModelRecord; revision: PredictionModelRecord['revisions'][number] }>
  | Readonly<{
      kind: 'dataset'
      asset: PredictionDatasetRecord
      revision: PredictionDatasetRecord['revisions'][number]
    }>

export type PredictionFileRow = Readonly<{
  key: string
  replica?: PredictionReplica
  storage?: PredictionStorage
  launcherIds: readonly string[]
  launcherNames: string
  files: readonly { name: string; byteLength: number | null; sha256: string | null }[]
  bytes: number | null
}> &
  AssetRevision

export function predictionFileRows(
  state: PredictionAssetsSnapshot,
  kind: 'model' | 'dataset' = 'model',
): PredictionFileRow[] {
  const revisions: AssetRevision[] =
    kind === 'model'
      ? state.models.flatMap((asset) =>
          asset.revisions.map((revision) => ({ kind: 'model' as const, asset, revision })),
        )
      : state.datasets.flatMap((asset) =>
          asset.revisions.map((revision) => ({ kind: 'dataset' as const, asset, revision })),
        )
  return revisions
    .filter((item) => item.asset.state !== 'deleted')
    .flatMap((item) => {
      const { asset, revision } = item
      const copies = revision.replicas.filter((copy) => copy.state !== 'deleted')
      return (copies.length ? copies : [undefined]).map((replica) => {
        const storage = state.storages.find((item) => item.storage_id === replica?.storage_id)
        const launcherIds = [...new Set(storage?.accesses.map((access) => access.launcher_id) ?? [])]
        const raw = replica?.artifact?.files ?? (item.kind === 'model' ? item.revision.artifact?.files : undefined)
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
          key: replica?.id ?? `${asset.id}:${revision.revision}:empty`,
          ...item,
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
    })
}

export function visiblePredictionFiles(rows: readonly PredictionFileRow[], params: URLSearchParams) {
  const search = (params.get('q') ?? '').trim().toLocaleLowerCase()
  const filtered = rows.filter((row) => {
    const fields: Record<string, string> = {
      experiment: String(row.asset.experiment_id),
      [row.kind]: row.asset.id,
      source: row.kind === 'dataset' ? row.asset.source_kind : '',
      revision: String(row.revision.revision),
      kind: row.storage?.kind ?? 'none',
      state: row.replica?.state ?? 'none',
    }
    return (
      row.asset.name.toLocaleLowerCase().includes(search) &&
      Object.entries(fields).every(([key, value]) => !params.get(key) || params.get(key) === value) &&
      (!params.get('launcher') || row.launcherIds.includes(params.get('launcher')!))
    )
  })
  const order = params.get('order') === 'desc' ? -1 : 1
  return filtered.sort((a, b) => {
    let compared = 0
    switch (params.get('sort')) {
      case 'name':
        compared = a.asset.name.localeCompare(b.asset.name)
        break
      case 'launcher':
        compared = a.launcherNames.localeCompare(b.launcherNames)
        break
      case 'revision':
        compared = a.revision.revision - b.revision.revision
        break
      case 'samples':
        compared =
          (a.kind === 'dataset' ? (a.revision.sample_count ?? -1) : -1) -
          (b.kind === 'dataset' ? (b.revision.sample_count ?? -1) : -1)
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
      a.asset.name.localeCompare(b.asset.name) ||
      b.revision.revision - a.revision.revision ||
      (a.storage?.name ?? '').localeCompare(b.storage?.name ?? '') ||
      a.key.localeCompare(b.key)
    )
  })
}

export function predictionFileActionReason(
  row: PredictionFileRow,
  action: 'verify' | 'remove',
  state?: PredictionAssetsSnapshot,
): string | null {
  if (!row.replica) return '복사본 없음'
  if (row.replica.state === 'deleting') return '기존 삭제 작업에서 계속하세요'
  if (row.asset.state !== 'active') return '전체 삭제 진행 중'
  if (action === 'remove' && row.kind === 'dataset' && state) {
    const reason = datasetTrainingReason(state, row.asset.id)
    if (reason) return reason
  }
  if (action === 'verify') {
    if (row.storage?.kind === 'api_dataset') return '서버 원본은 장비 파일 확인 대상이 아닙니다'
    if (row.storage?.kind !== 'predictor_local') return '백업은 복원할 때 파일을 검증합니다'
    if (!row.storage.accesses.some((access) => access.connected)) return '장비 오프라인'
  }
  return null
}

export function predictionRemovalSummary(rows: readonly PredictionFileRow[], selected: readonly PredictionFileRow[]) {
  const keys = new Set(selected.map((row) => row.key))
  const revisions = new Map(selected.map((row) => [`${row.asset.id}:${row.revision.revision}`, row]))
  return [...revisions.values()]
    .map((row) => {
      const remaining = rows.filter(
        (item) =>
          item.asset.id === row.asset.id &&
          item.revision.revision === row.revision.revision &&
          item.replica?.state === 'present' &&
          !keys.has(item.key),
      ).length
      return `${row.asset.name} r${row.revision.revision}: 제거 후 다른 검증된 복사본 ${remaining}개${remaining ? '' : ' · 마지막 복사본일 수 있음'}`
    })
    .join('\n')
}
