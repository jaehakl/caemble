import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { predictionApi } from '@/api/prediction'
import type { PredictionDatasetRecord } from '@/contracts/api/prediction'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PredictionAssetSettingsProps } from './RemotePredictionSettings'
import { predictionReplicaStatus, type PredictionAssetController } from './assetManagement'
import { startPredictionAssetOperation, verifyPredictionReplica } from './assetOperations'
import {
  datasetTrainingReason,
  importPredictionDataset,
  refreshPredictionDataset,
  savedDatasetSelection,
} from './datasetManagement'

export function PredictionDatasetManager({ manager, context, setup }: PredictionAssetSettingsProps) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [datasetId, setDatasetId] = useState(setup.datasetId ?? '')
  const dataset = state.datasets.find((item) => item.id === datasetId)
  return (
    <div role="tabpanel" aria-label="학습 데이터 관리" className="space-y-3">
      <label className="block text-sm">
        학습 데이터
        <select
          aria-label="Prediction Dataset"
          className="mt-1 w-full rounded border bg-background p-2"
          value={datasetId}
          onChange={(event) => setDatasetId(event.target.value)}
        >
          <option value="">학습 데이터 선택</option>
          {state.datasets
            .filter((item) => item.state !== 'deleted')
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · 최신 r{item.current_revision}
              </option>
            ))}
        </select>
      </label>
      {!state.datasets.length && (
        <p className="text-sm text-muted-foreground">
          등록된 학습 데이터가 없습니다. 통합 관리에서 학습 데이터를 만들 수 있습니다.
        </p>
      )}
      {dataset && (
        <PredictionDatasetDetail
          key={`${dataset.id}:${dataset.current_revision}`}
          manager={manager}
          dataset={dataset}
        />
      )}
      {context && (
        <PredictionDatasetImport manager={manager} experimentId={context.experimentId} onImported={setDatasetId} />
      )}
    </div>
  )
}

export function PredictionDatasetDetail({
  manager,
  dataset,
  initialRevision,
}: Readonly<{
  manager: PredictionAssetController
  dataset: PredictionDatasetRecord
  initialRevision?: number
}>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [name, setName] = useState(dataset.name)
  const [preview, setPreview] = useState<string | null>(null)
  const [revisionNumber, setRevisionNumber] = useState(initialRevision ?? dataset.current_revision)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const revision = dataset.revisions.find((item) => item.revision === revisionNumber)
  const trainingReason = datasetTrainingReason(state, dataset.id)
  const running = state.tasks.some((task) => task.state === 'running' && task.key.includes(dataset.id))
  const busy = Boolean(trainingReason) || running || dataset.state !== 'active'
  let sourceError: string | null = null
  if (dataset.source_kind === 'server') {
    try {
      savedDatasetSelection(dataset, 'validation')
    } catch (error) {
      sourceError = error instanceof Error ? error.message : String(error)
    }
  }
  const refresh = async (check: boolean) => {
    const result = await refreshPredictionDataset(manager, dataset, check)
    if (mounted.current)
      setPreview(result ? `추가 ${result.added}개 · 변경 ${result.changed}개 · 삭제 ${result.removed}개` : null)
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          데이터셋 이름
          <Input
            aria-label="데이터셋 이름"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={running || dataset.state !== 'active' || !name.trim() || name.trim() === dataset.name}
          onClick={() =>
            void manager.run(
              `rename:${dataset.id}`,
              '데이터셋 이름 변경',
              () => predictionApi.renameAsset('datasets', dataset.id, name.trim()),
              dataset.experiment_id,
            )
          }
        >
          이름 변경
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        일반 갱신은 최신 원본만 보관하며 저장 모델을 변경하지 않습니다. 명시적으로 백업·복원한 과거 원본은 유지됩니다.
        Experiment와 Record 구성을 바꾸려면 새 Dataset을 만드세요.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={running || dataset.state !== 'active' || Boolean(sourceError)}
          onClick={() => void refresh(true)}
        >
          새 데이터 확인
        </Button>
        <Button size="sm" variant="outline" disabled={busy || Boolean(sourceError)} onClick={() => void refresh(false)}>
          학습 데이터 갱신
        </Button>
      </div>
      {sourceError && <p className="text-xs text-muted-foreground">{sourceError}</p>}
      {trainingReason && (
        <p role="status" className="text-xs text-muted-foreground">
          {trainingReason}
        </p>
      )}
      {preview && (
        <p role="status" className="text-sm">
          {preview}
        </p>
      )}
      <label className="block text-sm">
        Revision
        <select
          aria-label="데이터셋 상세 Revision"
          className="ml-2 rounded border bg-background p-2"
          value={revisionNumber}
          onChange={(event) => setRevisionNumber(Number(event.target.value))}
        >
          {dataset.revisions.map((item) => (
            <option key={item.revision} value={item.revision}>
              r{item.revision}
              {item.revision === dataset.current_revision ? ' · 최신' : ''}
            </option>
          ))}
        </select>
      </label>
      {revision && (
        <div className="space-y-2 rounded border p-3 text-xs">
          <p className="font-medium">
            r{revision.revision} · {revision.sample_count ?? '알 수 없는'} 표본 ·{' '}
            {revision.payload_available ? '원본 보관 위치 있음' : '출처 기록만 보존'}
          </p>
          <p>
            출처: Experiment #{dataset.experiment_id} ·{' '}
            {dataset.source_kind === 'server' ? '서버 데이터' : '외부 가져오기'}
          </p>
          <p className="break-all">
            Source: {revision.source_contracts?.sourceHash ?? revision.source_hash ?? '알 수 없음'}
          </p>
          <p>
            Record:{' '}
            {revision.source_contracts?.records.map((record) => `${record.name} (#${record.id})`).join(', ') ||
              '출처 계약을 확인할 수 없음'}
          </p>
          <p className="break-all">Fingerprint: {revision.fingerprint}</p>
          {revision.replicas
            .filter((replica) => replica.state !== 'deleted')
            .map((replica) => {
              const storage = state.storages.find((item) => item.storage_id === replica.storage_id)
              return (
                <div key={replica.id} className="space-y-1">
                  <p>
                    {storage?.name ?? '저장소'} · {predictionReplicaStatus(replica, storage)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {storage?.kind === 'predictor_local' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          running ||
                          dataset.state !== 'active' ||
                          replica.state === 'deleting' ||
                          !storage.accesses.some((access) => access.connected)
                        }
                        onClick={() =>
                          void verifyPredictionReplica(manager, 'dataset', dataset.id, revision.revision, replica.id)
                        }
                      >
                        파일 확인
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || replica.state === 'deleting'}
                      onClick={() => {
                        const remaining = revision.replicas.filter(
                          (item) => item.id !== replica.id && item.state === 'present',
                        ).length
                        if (
                          window.confirm(
                            `${dataset.name} r${revision.revision}의 ${storage?.name ?? '이 위치'} 원본을 제거할까요? 다른 검증된 복사본 ${remaining}개${remaining ? '' : ' · 마지막 원본일 수 있음'}. 저장 모델과 원본 Measurement는 유지됩니다.`,
                          )
                        )
                          void startPredictionAssetOperation(manager, {
                            kind: 'delete_replica',
                            asset_kind: 'dataset',
                            asset_id: dataset.id,
                            revision: revision.revision,
                            replica_id: replica.id,
                          })
                      }}
                    >
                      이 위치에서 제거
                    </Button>
                  </div>
                </div>
              )
            })}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-destructive">학습 데이터 전체 삭제</summary>
        <p className="my-2 text-xs">
          Dataset 원본과 보관본만 삭제합니다. Measurement·RecordedData와 자체 저장된 모델은 유지됩니다.
        </p>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `${dataset.name}의 모든 revision 원본과 백업·복원본을 삭제할까요? 저장 모델과 원본 Measurement는 유지됩니다.`,
              )
            )
              void startPredictionAssetOperation(manager, {
                kind: 'delete_asset',
                asset_kind: 'dataset',
                asset_id: dataset.id,
              })
          }}
        >
          학습 데이터 전체 삭제 요청
        </Button>
      </details>
    </div>
  )
}

export function PredictionDatasetImport({
  manager,
  experimentId,
  onImported,
}: Readonly<{
  manager: PredictionAssetController
  experimentId: number
  onImported: (id: string) => void
}>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [launcherId, setLauncherId] = useState('')
  const [importId, setImportId] = useState('')
  const selectionVersion = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return (
    <details>
      <summary className="cursor-pointer text-sm">고급: 외부 Dataset 가져오기</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          Caemble Dataset artifact v1을 장비의 관리되는 imports 위치에 준비하세요. 선택한 Experiment에 속하는 파일을
          검증하고 출처를 보존하는 새 Dataset을 만듭니다.
        </p>
        <select
          aria-label="외부 Dataset 장비"
          className="w-full rounded border bg-background p-2 text-sm"
          value={launcherId}
          onChange={(event) => {
            selectionVersion.current += 1
            setLauncherId(event.target.value)
          }}
        >
          <option value="">장비 선택</option>
          {state.launchers.map((launcher) => (
            <option key={launcher.id} value={launcher.id}>
              {launcher.launcher_name}
            </option>
          ))}
        </select>
        <Input
          aria-label="로컬 Dataset import ID"
          placeholder="준비한 import ID"
          value={importId}
          onChange={(event) => {
            selectionVersion.current += 1
            setImportId(event.target.value)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={
            !launcherId ||
            !/^[A-Za-z0-9_-]+$/.test(importId) ||
            state.tasks.some((task) => task.key === `import:${launcherId}:${importId}` && task.state === 'running')
          }
          onClick={async () => {
            const selection = selectionVersion.current
            const id = await importPredictionDataset(manager, experimentId, launcherId, importId)
            if (id && mounted.current && selection === selectionVersion.current) onImported(id)
          }}
        >
          외부 Dataset 가져오기
        </Button>
      </div>
    </details>
  )
}
