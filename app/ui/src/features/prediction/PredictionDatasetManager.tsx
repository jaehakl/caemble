import { useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { predictionApi } from '@/api/prediction'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PredictionAssetSettingsProps } from './RemotePredictionSettings'
import { predictionReplicaStatus, type PredictionAssetWork } from './assetManagement'
import { predictionDatasetSelection } from './assetCreation'
import { startPredictionAssetOperation, verifyPredictionReplica } from './assetOperations'

export function PredictionDatasetManager({
  manager,
  context,
  sourceHash,
  varsSchema,
  rules,
  resultContracts,
  setup,
}: PredictionAssetSettingsProps) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [datasetId, setDatasetId] = useState(setup.datasetId ?? '')
  const [launcherId, setLauncherId] = useState('')
  const [importId, setImportId] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const selectionVersion = useRef(0)
  const dataset = state.datasets.find((item) => item.id === datasetId)
  const trainingUsesDataset = state.operations.some(
    (operation) =>
      operation.kind === 'prepare' &&
      operation.details.dataset_id === datasetId &&
      (operation.training?.cleanupPending ||
        !['completed', 'succeeded', 'failed', 'interrupted', 'cancelled', 'superseded'].includes(operation.state)),
  )
  const input =
    context && sourceHash && varsSchema
      ? { context, sourceHash, varsSchema, rules, resultContracts, setup, name: dataset?.name ?? '', dataset }
      : null
  const localDataset = async (work: PredictionAssetWork) => {
    const replica = dataset?.revisions
      .find((item) => item.revision === dataset.current_revision)
      ?.replicas.find((item) =>
        state.storages.some(
          (storage) =>
            storage.storage_id === item.storage_id &&
            storage.kind === 'predictor_local' &&
            storage.accesses.some((access) => access.connected),
        ),
      )
    const access = state.storages
      .find((item) => item.storage_id === replica?.storage_id)
      ?.accesses.find((item) => item.connected)
    if (!access) throw new Error('원본 Dataset 장비를 연결하세요.')
    const remote = await work.connect(access.launcher_id)
    if (remote.hello?.storageId !== replica?.storage_id)
      throw new Error('원본 Dataset 저장소와 장비의 저장소가 다릅니다.')
    return remote
  }
  return (
    <div role="tabpanel" aria-label="학습 데이터 관리" className="space-y-3">
      <label className="block text-sm">
        학습 데이터
        <select
          aria-label="Prediction Dataset"
          className="mt-1 w-full rounded border bg-background p-2"
          value={datasetId}
          onChange={(event) => {
            selectionVersion.current += 1
            setDatasetId(event.target.value)
            setPreview(null)
          }}
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
          등록된 학습 데이터가 없습니다. 모델 만들기에서 현재 데이터를 함께 준비할 수 있습니다.
        </p>
      )}
      {dataset && (
        <>
          <p className="text-xs text-muted-foreground">
            일반 갱신은 최신 원본만 보관하며 저장 모델을 변경하지 않습니다. 명시적으로 백업·복원한 과거 원본은
            유지됩니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!input || dataset.state !== 'active'}
              onClick={() => {
                const selection = selectionVersion.current
                void manager.run(`preview:${dataset.id}`, '새 데이터 확인', async (work) => {
                  if (!input) return
                  const result =
                    dataset.source_kind === 'server'
                      ? await predictionApi.previewDataset(
                          dataset.id,
                          predictionDatasetSelection(input, crypto.randomUUID()),
                          { signal: work.signal },
                        )
                      : z
                          .object({ added: z.number(), changed: z.number(), removed: z.number() })
                          .parse(
                            await (
                              await localDataset(work)
                            ).command(
                              'dataset.preview',
                              { datasetId: dataset.id, experimentId: context?.experimentId },
                              { requestId: crypto.randomUUID(), signal: work.signal },
                            ),
                          )
                  if (manager.active && selection === selectionVersion.current)
                    setPreview(`추가 ${result.added}개 · 변경 ${result.changed}개 · 삭제 ${result.removed}개`)
                })
              }}
            >
              새 데이터 확인
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!input || dataset.state !== 'active' || trainingUsesDataset}
              onClick={() => {
                const requestId = crypto.randomUUID()
                const selection = selectionVersion.current
                void manager.run(`sync:${dataset.id}`, '학습 데이터 갱신', async (work) => {
                  if (!input) return
                  if (dataset.source_kind === 'server')
                    await predictionApi.syncDataset(dataset.id, predictionDatasetSelection(input, requestId), {
                      signal: work.signal,
                    })
                  else {
                    const remote = await localDataset(work)
                    await remote.command(
                      'dataset.sync',
                      { datasetId: dataset.id, experimentId: context?.experimentId },
                      { requestId: crypto.randomUUID(), signal: work.signal },
                    )
                    await remote.inspect({ requestId: crypto.randomUUID(), signal: work.signal })
                  }
                  if (manager.active && selection === selectionVersion.current) setPreview(null)
                })
              }}
            >
              학습 데이터 갱신
            </Button>
          </div>
          {trainingUsesDataset && (
            <p role="status" className="text-xs text-muted-foreground">
              모델 학습에서 사용 중입니다. 학습과 프로세스 정리가 끝난 뒤 갱신·삭제할 수 있습니다.
            </p>
          )}
          {preview && (
            <p role="status" className="text-sm">
              {preview}
            </p>
          )}
          {dataset.revisions.map((revision) => (
            <div className="space-y-2 rounded border p-2 text-xs" key={revision.revision}>
              <p className="font-medium">
                r{revision.revision} · {revision.sample_count ?? '확인된'} 표본 ·{' '}
                {revision.payload_available ? '원본 보관 위치 있음' : '출처 기록만 보존'}
              </p>
              {revision.replicas
                .filter((replica) => replica.state !== 'deleted')
                .map((replica) => {
                  const storage = state.storages.find((item) => item.storage_id === replica.storage_id)
                  return (
                    <div key={replica.id}>
                      <p>
                        {storage?.name ?? '저장소'} · {predictionReplicaStatus(replica, storage)}
                      </p>
                      <div className="mt-1 flex gap-2">
                        {storage?.kind === 'predictor_local' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void verifyPredictionReplica(
                                manager,
                                'dataset',
                                dataset.id,
                                revision.revision,
                                replica.id,
                              )
                            }
                          >
                            파일 확인
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={trainingUsesDataset}
                          onClick={() => {
                            if (
                              window.confirm(
                                `${dataset.name} r${revision.revision}의 ${storage?.name ?? '이 위치'} 원본을 제거할까요? 마지막 원본일 수 있습니다. 사용 중이면 해제 후 처리하며 저장 모델과 원본 Measurement는 유지됩니다.`,
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
          ))}
          <details>
            <summary className="cursor-pointer text-sm text-destructive">학습 데이터 전체 삭제</summary>
            <p className="my-2 text-xs">
              Dataset 원본과 보관본만 삭제합니다. Measurement·RecordedData와 자체 저장된 모델은 유지됩니다.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={trainingUsesDataset}
              onClick={() => {
                if (window.confirm(`${dataset.name}의 모든 원본과 백업·복원본을 삭제할까요? 저장 모델은 유지됩니다.`))
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
        </>
      )}
      <details>
        <summary className="cursor-pointer text-sm">고급: 외부 Dataset 가져오기</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Caemble Dataset artifact v1을 장비의 관리되는 imports 위치에 준비하세요. 가져오기는 파일을 검증하고 출처를
            보존하는 새 Dataset을 만듭니다. 백업 복원과 다릅니다.
          </p>
          <select
            aria-label="외부 Dataset 장비"
            className="w-full rounded border bg-background p-2 text-sm"
            value={launcherId}
            onChange={(event) => setLauncherId(event.target.value)}
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
            onChange={(event) => setImportId(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!launcherId || !/^[A-Za-z0-9_-]+$/.test(importId)}
            onClick={() => {
              const selection = selectionVersion.current
              void manager.run(`import:${launcherId}:${importId}`, '외부 Dataset 가져오기', async (work) => {
                const remote = await work.connect(launcherId)
                const result = z
                  .object({ dataset: z.object({ datasetId: z.string() }) })
                  .parse(
                    await remote.command(
                      'dataset.import',
                      { importId, experimentId: context?.experimentId },
                      { requestId: crypto.randomUUID(), signal: work.signal },
                    ),
                  )
                await remote.inspect({ requestId: crypto.randomUUID(), signal: work.signal })
                if (manager.active && selection === selectionVersion.current) setDatasetId(result.dataset.datasetId)
              })
            }}
          >
            외부 Dataset 가져오기
          </Button>
        </div>
      </details>
    </div>
  )
}
