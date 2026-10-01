import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import type { PredictionAssetController } from './assetManagement'
import { retryPredictionAssetOperation } from './assetOperations'

const stages: Readonly<Record<string, string>> = {
  pending: '준비 중',
  queued: '대기 중',
  running: '진행 중',
  preparing: '모델 준비 중',
  deleting: '파일 삭제 확인 대기',
  staging: '파일 준비 중',
  transferring: '전송 중',
  verifying: 'checksum 검증 중',
  registering: '등록 중',
  succeeded: '완료',
  completed: '완료',
  cancelled: '중단됨',
  failed: '실패',
  interrupted: '연결 중단 · 재시도 가능',
  delete_pending: '파일 삭제 확인 대기',
}

export function PredictionAssetTasks({
  manager,
  assetId,
}: Readonly<{ manager: PredictionAssetController; assetId?: string }>) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const operations = state.operations.filter((operation) => !assetId || operation.asset_id === assetId)
  const tasks = state.tasks.filter(
    (task) =>
      !assetId || task.key.includes(assetId) || operations.some((operation) => operation.id === task.operationId),
  )
  return (
    <div role="tabpanel" aria-label="관리 작업" className="space-y-2">
      <p className="text-xs text-muted-foreground">
        이 화면을 닫아도 시작한 작업은 계속됩니다. 브라우저 종료로 중단되면 다시 조회하고 같은 작업을 재시도하세요.
      </p>
      {!tasks.length && !operations.length && <p className="text-sm">관리 작업이 없습니다.</p>}
      {tasks.map((task) => (
        <div key={task.id} className="space-y-1 rounded border p-2 text-xs">
          <p className="font-medium">{task.label}</p>
          <p>{task.message}</p>
          {task.state === 'running' &&
          !task.key.startsWith('delete') &&
          !state.operations.some(
            (operation) => operation.id === task.operationId && operation.kind.startsWith('delete'),
          ) ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void manager.cancelTask(task.id)}>
              이 작업 중단
            </Button>
          ) : (
            ['failed', 'waiting'].includes(task.state) && (
              <Button type="button" size="sm" variant="outline" onClick={() => void manager.retryTask(task.id)}>
                다시 시도
              </Button>
            )
          )}
        </div>
      ))}
      {operations
        .filter((operation) => !tasks.some((task) => task.operationId === operation.id))
        .map((operation) => (
          <div key={operation.id} className="space-y-1 rounded border p-2 text-xs">
            <p className="font-medium break-words">
              {(operation.asset_kind === 'model' ? state.models : state.datasets).find(
                (asset) => asset.id === operation.asset_id,
              )?.name ?? '삭제된 자산'}
              {operation.revision ? ` · r${operation.revision}` : ' · 전체 버전'}
            </p>
            <p>
              {operation.kind === 'backup'
                ? '백업'
                : operation.kind === 'restore'
                  ? '복원'
                  : operation.kind.startsWith('delete')
                    ? '삭제'
                    : operation.kind === 'verify'
                      ? '파일 확인'
                      : '모델 준비'}{' '}
              ·{' '}
              {['failed', 'interrupted', 'cancelled', 'completed'].includes(operation.state)
                ? stages[operation.state]
                : (stages[operation.stage] ?? stages[operation.state] ?? '상태 확인 중')}
            </p>
            {operation.error && <p className="text-destructive">{operation.error}</p>}
            {operation.kind === 'prepare' && operation.details.direction === 'inverse' && (
              <p>Inverse 모델 준비는 지원 종료되었습니다. 기존 저장 파일은 유지됩니다.</p>
            )}
            {!['succeeded', 'completed', 'cancelled'].includes(operation.state) && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operation.kind === 'prepare' && operation.details.direction === 'inverse'}
                  onClick={() => void retryPredictionAssetOperation(manager, operation)}
                >
                  상태 확인·다시 시도
                </Button>
                {!operation.kind.startsWith('delete') && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void manager.cancelOperation(operation.id)}
                  >
                    이 작업 중단
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  )
}
