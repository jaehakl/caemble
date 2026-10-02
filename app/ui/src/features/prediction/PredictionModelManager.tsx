import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { predictionApi } from '@/api/prediction'
import type { PredictionModelRecord, PredictionReplica, PredictionStorage } from '@/contracts/api/prediction'
import type { PredictionSetup } from './usePredictionModels'
import type { PredictionDirection } from './types'
import { predictionReplicaStatus, type PredictionAssetController } from './assetManagement'
import { modelExecutionRoutes, preferredModelRoute, setupUsingSavedModel } from './remoteAssets'
import {
  retryPredictionAssetOperation,
  startPredictionAssetOperation,
  verifyPredictionReplica,
} from './assetOperations'
import { PredictionModelReports } from './PredictionModelReports'

export function PredictionModelManager({
  manager,
  setup,
  onChange,
  onUse,
  onNewVersion,
}: Readonly<{
  manager: PredictionAssetController
  setup: PredictionSetup
  onChange: (setup: PredictionSetup) => void
  onUse: (setup: PredictionSetup, direction?: PredictionDirection) => void
  onNewVersion: (model: PredictionModelRecord) => void
}>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [detailId, setDetailId] = useState<string | null>(null)
  const model = state.models.find((item) => item.id === detailId)
  return (
    <div className="space-y-3">
      {state.models.length === 0 && (
        <p className="py-3 text-sm text-muted-foreground">
          아직 저장 모델이 없습니다. 학습 데이터와 장비를 확인한 뒤 BoxGrid를 예측할 모델을 만드세요.
        </p>
      )}
      <div className="max-h-64 space-y-2 overflow-y-auto" aria-label="등록된 모델">
        {state.models
          .filter((item) => item.state !== 'deleted')
          .map((item) => {
            const selected = item.direction === 'forward' ? setup.models?.forward : undefined
            return (
              <button
                key={item.id}
                type="button"
                className={`w-full rounded-md border p-3 text-left text-sm ${item.id === detailId ? 'border-primary bg-primary/5' : ''}`}
                onClick={() => setDetailId(item.id)}
                aria-pressed={item.id === detailId}
              >
                <span className="block font-medium break-words">{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {item.direction === 'forward' ? 'Forward' : 'Inverse · 지원 종료'} ·{' '}
                  {item.current_revision ? `최신 r${item.current_revision}` : '첫 모델 준비 중'}
                  {selected?.modelId === item.id ? ` · 선택 r${selected.modelRevision}` : ''}
                  {item.state === 'deleting' ? ' · 삭제 확인 대기' : ''}
                </span>
              </button>
            )
          })}
      </div>
      {model && (
        <ModelDetail
          key={model.id}
          manager={manager}
          model={model}
          setup={setup}
          onChange={onChange}
          onUse={onUse}
          onNewVersion={onNewVersion}
        />
      )}
    </div>
  )
}

export function ModelDetail({
  manager,
  model,
  setup,
  onChange,
  onUse,
  onNewVersion,
  initialRevision,
  managementOnly = false,
}: Readonly<{
  manager: PredictionAssetController
  model: PredictionModelRecord
  setup: PredictionSetup
  onChange: (setup: PredictionSetup) => void
  onUse: (setup: PredictionSetup, direction?: PredictionDirection) => void
  onNewVersion: (model: PredictionModelRecord) => void
  initialRevision?: number
  managementOnly?: boolean
}>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const selected = model.direction === 'forward' ? setup.models?.forward : undefined
  const [revisionNumber, setRevisionNumber] = useState(
    initialRevision ??
      (selected?.modelId === model.id
        ? selected.modelRevision
        : model.current_revision || model.revisions[0]?.revision || 1),
  )
  const [name, setName] = useState(model.name)
  const [routeKey, setRouteKey] = useState('')
  const [backupSourceKey, setBackupSourceKey] = useState('')
  const [backupStorageId, setBackupStorageId] = useState('')
  const [includeDataset, setIncludeDataset] = useState(false)
  const [restoreDataset, setRestoreDataset] = useState(false)
  const [datasetSourceId, setDatasetSourceId] = useState('')
  const [restoreLauncherId, setRestoreLauncherId] = useState('')
  const [message, setMessage] = useState('')
  const revision = model.revisions.find((item) => item.revision === revisionNumber)
  if (!revision) return <p>모델 revision 등록을 확인하는 중입니다.</p>
  const routes = modelExecutionRoutes(model, revisionNumber, state.storages)
  const preferred = preferredModelRoute(
    model,
    revisionNumber,
    state.storages,
    model.direction === 'forward' ? setup.routes?.forward : undefined,
  )
  const selectedRoute =
    routes.find((route) => `${route.replicaId}:${route.launcherId}` === routeKey) ??
    routes.find((route) => route.replicaId === preferred?.replicaId && route.launcherId === preferred?.launcherId)
  const backupSources = routes.filter((route) => route.state === 'present' || route.state === 'unverified')
  const backupSource =
    backupSources.find((route) => `${route.replicaId}:${route.launcherId}` === backupSourceKey) ??
    selectedRoute ??
    (backupSources.length === 1 ? backupSources[0] : undefined)
  const destinations = state.storages.filter(
    (storage) => storage.kind === 'object_backup' && storage.configured !== false,
  )
  const backupDestination =
    destinations.find((storage) => storage.storage_id === backupStorageId) ??
    (destinations.length === 1 ? destinations[0] : undefined)
  const backups = revision.replicas.filter(
    (replica) =>
      replica.state === 'present' &&
      state.storages.some((storage) => storage.kind === 'object_backup' && storage.storage_id === replica.storage_id),
  )
  const dataset = state.datasets.find((item) => item.id === revision.dataset_id)
  const datasetRevision = dataset?.revisions.find((item) => item.revision === revision.dataset_revision)
  const dataSources = (datasetRevision?.replicas ?? []).flatMap<{
    key: string
    replica: PredictionReplica
    storage: PredictionStorage
    launcherId: string | undefined
    label: string
  }>((replica) => {
    if (dataset?.state !== 'active' || !['present', 'unverified'].includes(replica.state)) return []
    const storage = state.storages.find((item) => item.storage_id === replica.storage_id)
    if (!storage) return []
    if (storage.kind !== 'predictor_local')
      return [{ key: replica.id, replica, storage, launcherId: undefined, label: storage.name }]
    return storage.accesses.map((access) => ({
      key: `${replica.id}:${access.launcher_id}`,
      replica,
      storage,
      launcherId: access.launcher_id,
      label: `${storage.name} · ${state.launchers.find((item) => item.id === access.launcher_id)?.launcher_name ?? '등록된 장비'}${access.connected ? '' : ' · 오프라인'}`,
    }))
  })
  const dataSource =
    dataSources.find((item) => item.key === datasetSourceId) ??
    dataSources.find((item) => item.storage.kind === 'api_dataset') ??
    dataSources.find((item) => item.storage.kind === 'object_backup') ??
    dataSources.find(
      (item) => item.storage.storage_id === backupSource?.storageId && item.launcherId === backupSource?.launcherId,
    )
  const hasDatasetBackup = dataSources.some(
    (item) => item.storage.kind === 'object_backup' && item.replica.state === 'present',
  )
  const profile = revision.artifact?.profile as { rowCount?: number } | undefined
  const active = model.state === 'active'
  const executable =
    model.direction === 'forward' && revision.support_status !== 'retired' && revision.support_status !== 'unsupported'
  const useModel = () => {
    if (executable) onUse(setupUsingSavedModel(setup, model, revisionNumber, selectedRoute), 'forward')
  }
  const restore = async (replicaId: string, useAfter: boolean) => {
    const key = manager.currentSelectionKey
    const result = await startPredictionAssetOperation(manager, {
      kind: 'restore',
      asset_kind: 'model',
      asset_id: model.id,
      revision: revisionNumber,
      source_replica_id: replicaId,
      target_launcher_id: restoreLauncherId,
      include_dataset: restoreDataset,
    })
    if (
      executable &&
      useAfter &&
      result &&
      ['succeeded', 'completed'].includes(result.state) &&
      manager.active &&
      manager.currentSelectionKey === key
    ) {
      const fresh = manager.getSnapshot().models.find((item) => item.id === model.id)
      if (!fresh) return
      const copy = fresh.revisions
        .find((item) => item.revision === revisionNumber)
        ?.replicas.find((item) => item.storage_id === result.target_storage_id)
      if (!copy) return
      onUse(
        setupUsingSavedModel(setup, fresh, revisionNumber, {
          replicaId: copy.id,
          storageId: copy.storage_id,
          launcherId: restoreLauncherId,
        }),
        'forward',
      )
    }
  }
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="모델 상세">
      {!executable && (
        <p role="status" className="text-sm">
          {model.direction === 'inverse' ? 'Inverse 모델 · 지원 종료.' : '지원하지 않는 알고리즘·버전입니다.'} 저장
          파일의 백업·복원·관리는 계속 사용할 수 있습니다.
        </p>
      )}
      <div className="flex gap-2">
        <Input aria-label="모델 이름" value={name} onChange={(event) => setName(event.target.value)} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!name.trim() || name === model.name}
          onClick={() =>
            void manager.run(`rename:${model.id}`, '모델 이름 변경', () =>
              predictionApi.renameAsset('models', model.id, name.trim()),
            )
          }
        >
          이름 저장
        </Button>
      </div>
      <label className="block text-sm">
        버전
        <select
          className="mt-1 w-full rounded border bg-background p-2"
          aria-label="모델 버전"
          disabled={managementOnly}
          value={revisionNumber}
          onChange={(event) => {
            setRevisionNumber(Number(event.target.value))
            setRouteKey('')
            setBackupSourceKey('')
            setDatasetSourceId('')
            setRestoreDataset(false)
          }}
        >
          {model.revisions.map((item) => (
            <option key={item.revision} value={item.revision}>
              {item.version_name ? `${item.version_name} · ` : ''}r{item.revision} · Dataset r{item.dataset_revision}
              {item.state === 'ready' ? '' : ' · 준비 중'}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {typeof profile?.rowCount === 'number' ? `학습 데이터 ${profile.rowCount.toLocaleString()}개 · ` : ''}
        {dataset?.name ?? '학습 데이터'} r{revision.dataset_revision}. 저장 모델은 해당 버전의 설정과 데이터를
        사용합니다.
      </p>
      <PredictionModelReports artifact={revision.artifact} />
      {!managementOnly && executable && (
        <label className="block text-sm">
          실행 위치
          <select
            className="mt-1 w-full rounded border bg-background p-2"
            aria-label="모델 실행 위치"
            value={selectedRoute ? `${selectedRoute.replicaId}:${selectedRoute.launcherId}` : ''}
            onChange={(event) => setRouteKey(event.target.value)}
          >
            <option value="">실행 위치 선택</option>
            {routes.map((route) => (
              <option key={`${route.replicaId}:${route.launcherId}`} value={`${route.replicaId}:${route.launcherId}`}>
                {route.name} ·{' '}
                {state.launchers.find((item) => item.id === route.launcherId)?.launcher_name ?? '등록된 장비'} ·{' '}
                {route.connected ? '연결 가능' : '오프라인'}
              </option>
            ))}
          </select>
        </label>
      )}
      {routes.length === 0 && (
        <p className="text-sm">
          {backups.length
            ? '이 모델은 백업에 보관되어 있습니다. 예측하려면 사용할 장비에 복원하세요.'
            : '실행할 복사본이 없습니다. 저장 파일을 확인하거나 백업에서 복원하세요.'}
        </p>
      )}
      {!managementOnly && executable && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!active || revision.state !== 'ready' || !selectedRoute}
            onClick={useModel}
          >
            이 모델 사용
          </Button>
          {selected?.modelId === model.id && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const models = { ...setup.models }
                const nextRoutes = { ...setup.routes }
                delete models.forward
                delete nextRoutes.forward
                onChange({ ...setup, models, routes: nextRoutes })
              }}
            >
              선택 해제
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={!active} onClick={() => onNewVersion(model)}>
            새 버전 만들기
          </Button>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm">저장된 설정·ID·checksum</summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(
            {
              modelId: model.id,
              revision: revisionNumber,
              datasetId: revision.dataset_id,
              datasetRevision: revision.dataset_revision,
              manifestChecksum: revision.artifact?.manifest_sha256,
              algorithm: revision.definition.algorithm,
              preprocessingVersion: revision.definition.preprocessingVersion,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-medium">저장 위치</h4>
        {revision.replicas
          .filter((replica) => replica.state !== 'deleted')
          .map((replica) => {
            const storage = state.storages.find((item) => item.storage_id === replica.storage_id)
            const others = revision.replicas.filter((item) => item.id !== replica.id && item.state === 'present').length
            return (
              <div className="space-y-1 rounded border p-2 text-xs" key={replica.id}>
                <p className="font-medium break-words">{storage?.name ?? '등록된 저장소'}</p>
                <p>{predictionReplicaStatus(replica, storage)}</p>
                {replica.deletion && <p role="status">{replica.deletion.message}</p>}
                <p className="text-muted-foreground">
                  마지막 확인: {replica.checked_at ? new Date(replica.checked_at).toLocaleString() : '미확인'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {replica.state === 'deleting' && replica.delete_id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void retryPredictionAssetOperation(manager, replica.delete_id!)}
                    >
                      삭제 상태 확인·계속
                    </Button>
                  ) : (
                    <>
                      {active && storage?.kind === 'predictor_local' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void verifyPredictionReplica(manager, 'model', model.id, revisionNumber, replica.id)
                          }
                        >
                          파일 확인
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!active}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `${storage?.name ?? '이 저장 위치'}에서 ${model.name} r${revisionNumber} 복사본을 제거할까요? 다른 검증된 복사본 ${others}개.${others === 0 ? ' 마지막 확인된 복사본일 수 있습니다.' : ''} 사용 중이면 해제 후 삭제하며 오프라인 파일은 확인 대기로 남습니다.`,
                            )
                          )
                            return
                          void startPredictionAssetOperation(manager, {
                            kind: 'delete_replica',
                            asset_kind: 'model',
                            asset_id: model.id,
                            revision: revisionNumber,
                            replica_id: replica.id,
                          })
                        }}
                      >
                        이 위치에서 제거
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
      </div>
      {active && (
        <div className="space-y-3 border-t pt-3">
          <h4 className="text-sm font-medium">백업</h4>
          <label className="block text-sm">
            모델 원본
            <select
              className="mt-1 w-full rounded border bg-background p-2"
              aria-label="백업 원본"
              value={backupSource ? `${backupSource.replicaId}:${backupSource.launcherId}` : ''}
              onChange={(event) => setBackupSourceKey(event.target.value)}
            >
              <option value="">원본 위치 선택</option>
              {backupSources.map((route) => (
                <option key={`${route.replicaId}:${route.launcherId}`} value={`${route.replicaId}:${route.launcherId}`}>
                  {route.name} · {state.launchers.find((item) => item.id === route.launcherId)?.launcher_name ?? '장비'}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            백업 목적지
            <select
              className="mt-1 w-full rounded border bg-background p-2"
              aria-label="백업 목적지"
              value={backupDestination?.storage_id ?? ''}
              onChange={(event) => setBackupStorageId(event.target.value)}
            >
              <option value="">백업 저장소 선택</option>
              {destinations.map((storage) => (
                <option key={storage.storage_id} value={storage.storage_id}>
                  {storage.name}
                </option>
              ))}
            </select>
          </label>
          {!destinations.length && (
            <p className="text-xs text-muted-foreground">서버의 object storage 설정을 확인하세요.</p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeDataset}
              onChange={(event) => setIncludeDataset(event.target.checked)}
            />
            학습 데이터 r{revision.dataset_revision} 원본도 포함
          </label>
          <p className="text-xs text-muted-foreground">
            모델만 백업해도 다시 예측할 수 있습니다. 학습 원본은 별도로 선택한 경우에만 보관합니다.
          </p>
          {includeDataset && (
            <label className="block text-sm">
              학습 데이터 원본
              <select
                className="mt-1 w-full rounded border bg-background p-2"
                aria-label="백업 학습 데이터 원본"
                value={dataSource?.key ?? ''}
                onChange={(event) => setDatasetSourceId(event.target.value)}
              >
                <option value="">동일 revision 원본 위치 선택</option>
                {dataSources.map((source) => (
                  <option key={source.key} value={source.key}>
                    {source.label} · r{revision.dataset_revision}
                  </option>
                ))}
              </select>
            </label>
          )}
          {includeDataset && !datasetRevision?.payload_available && (
            <p className="text-sm text-destructive">
              모델 예측은 복원할 수 있지만 사용한 학습 데이터 r{revision.dataset_revision} 원본은 보관되어 있지
              않습니다.
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={!backupSource || !backupDestination || (includeDataset && !dataSource)}
            onClick={() => {
              if (!backupSource || !backupDestination) return
              void startPredictionAssetOperation(manager, {
                kind: 'backup',
                asset_kind: 'model',
                asset_id: model.id,
                revision: revisionNumber,
                source_replica_id: backupSource.replicaId,
                source_launcher_id: backupSource.launcherId,
                target_storage_id: backupDestination.storage_id,
                include_dataset: includeDataset,
                ...(includeDataset && dataSource
                  ? {
                      dataset_source_replica_id: dataSource.replica.id,
                      dataset_source_launcher_id: dataSource.launcherId,
                    }
                  : {}),
              })
            }}
          >
            백업하기
          </Button>
          {backups.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <h4 className="text-sm font-medium">백업에서 복원</h4>
              <label className="block text-sm">
                대상 장비
                <select
                  className="mt-1 w-full rounded border bg-background p-2"
                  aria-label="복원 대상 장비"
                  value={restoreLauncherId}
                  onChange={(event) => setRestoreLauncherId(event.target.value)}
                >
                  <option value="">복원할 장비 선택</option>
                  {state.launchers.map((launcher) => (
                    <option key={launcher.id} value={launcher.id}>
                      {launcher.launcher_name} · {launcher.status}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={restoreDataset}
                  disabled={!hasDatasetBackup}
                  onChange={(event) => setRestoreDataset(event.target.checked)}
                />
                학습 데이터 r{revision.dataset_revision} 보관본도 복원
              </label>
              {!hasDatasetBackup && (
                <p className="text-xs text-muted-foreground">
                  해당 학습 데이터 원본의 백업은 없습니다. 모델은 별도로 복원할 수 있습니다.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                선택한 장비의 Predictor 저장소에 같은 모델 r{revisionNumber}을 복원합니다.{' '}
                {restoreDataset
                  ? `학습 데이터 r${revision.dataset_revision}도 복원합니다.`
                  : '모델 재사용용 파일을 복원합니다.'}
              </p>
              {backups.map((backup) => (
                <div className="flex flex-wrap items-center gap-2" key={backup.id}>
                  <span className="text-xs">
                    {state.storages.find((item) => item.storage_id === backup.storage_id)?.name ?? '백업 저장소'}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!restoreLauncherId}
                    onClick={() => void restore(backup.id, false)}
                  >
                    복원
                  </Button>
                  {!managementOnly && executable && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!restoreLauncherId}
                      onClick={() => void restore(backup.id, true)}
                    >
                      복원하고 사용
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm text-destructive">모델 전체 삭제</summary>
        <p className="my-2 text-xs">
          모든 모델 revision과 백업·로컬 복사본이 삭제 대상입니다. 별도로 보관한 학습 데이터와 원본 Measurement는
          유지됩니다. 사용 중이거나 오프라인인 위치는 삭제 확인 대기로 남습니다.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => {
            if (model.delete_id) {
              void retryPredictionAssetOperation(manager, model.delete_id)
              return
            }
            if (
              !window.confirm(
                `${model.name}의 모든 revision과 모든 모델 백업을 삭제할까요? 마지막 모델 복사본도 삭제됩니다. 학습 데이터는 별도로 보존됩니다.`,
              )
            )
              return
            setMessage('모든 저장 위치의 삭제 확인을 요청합니다.')
            void startPredictionAssetOperation(manager, {
              kind: 'delete_asset',
              asset_kind: 'model',
              asset_id: model.id,
            })
          }}
        >
          {model.delete_id ? '모델 전체 삭제 상태 확인·계속' : '모델 전체 삭제 요청'}
        </Button>
      </details>
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </section>
  )
}
