import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import type { PredictionSetup } from './usePredictionModels'
import { predictionReplicaStatus, type PredictionAssetController } from './assetManagement'

export function PredictionModelSummary({
  manager,
  setup,
  onManage,
}: Readonly<{
  manager: PredictionAssetController
  setup: PredictionSetup
  onManage: () => void
}>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  return (
    <section
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
      aria-label="현재 Prediction 모델"
    >
      <div className="min-w-0 space-y-1">
        {(['forward'] as const).map((direction) => {
          const reference = setup.models?.[direction]
          if (!reference)
            return (
              <p className="text-muted-foreground" key={direction}>
                Forward · 모델 미선택
              </p>
            )
          const model = state.models.find((item) => item.id === reference.modelId)
          const revision = model?.revisions.find((item) => item.revision === reference.modelRevision)
          const route = setup.routes?.[direction]
          const replica = revision?.replicas.find((item) =>
            route?.replicaId ? item.id === route.replicaId : item.storage_id === route?.storageId,
          )
          const storage = state.storages.find((item) => item.storage_id === replica?.storage_id)
          const launcher = state.launchers.find((item) => item.id === route?.launcherId)
          const backupOnly =
            !replica &&
            revision?.replicas.some(
              (item) =>
                item.state === 'present' &&
                state.storages.some(
                  (location) => location.storage_id === item.storage_id && location.kind === 'object_backup',
                ),
            )
          const profile = revision?.artifact?.profile as { rowCount?: number } | undefined
          return (
            <div key={direction}>
              <p className="truncate font-medium" title={model?.name}>
                {model?.algorithm ?? 'kNN'} · {model?.name ?? '저장 모델'} · r{reference.modelRevision}
              </p>
              <p className="text-muted-foreground">
                {typeof profile?.rowCount === 'number' ? `학습 데이터 ${profile.rowCount.toLocaleString()}개 · ` : ''}
                {storage?.name ? `${storage.name} · ` : ''}
                {launcher?.launcher_name ? `${launcher.launcher_name} · ` : ''}
                {backupOnly
                  ? '백업에서 복원 필요'
                  : predictionReplicaStatus(
                      replica,
                      storage && {
                        ...storage,
                        accesses: storage.accesses.filter((access) => access.launcher_id === route?.launcherId),
                      },
                    )}
              </p>
            </div>
          )
        })}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onManage}>
        데이터·모델 관리
      </Button>
    </section>
  )
}
