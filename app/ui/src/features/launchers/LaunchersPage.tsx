import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Server, Square, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { dbTables } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { formatRuntimeDate, runtimeErrorMessage } from '@/features/runtime/format'
import { bundledSlaveManifests } from '@/features/runtime/manifests'
import { invalidateLauncherMutation } from '@/features/runtime/queryInvalidation'
import { launchersQueryOptions } from '@/features/runtime/queryOptions'
import { describeResourceWait, formatMemory } from '@/features/runtime/resources'
import { cn } from '@/lib/utils'

export function LaunchersWorkspace({
  className,
  compact = false,
  onRequestLogin,
}: {
  className?: string
  compact?: boolean
  onRequestLogin?: () => void
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [activeOnly, setActiveOnly] = useState(true)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [reconciling, setReconciling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const launchers = useQuery(launchersQueryOptions(auth.queryScope, auth.isAuthenticated))
  const runtimeByLauncher = useMemo(
    () => new Map(launchers.data?.runtime.map((item) => [item.launcher_id, item]) ?? []),
    [launchers.data?.runtime],
  )
  const visibleLaunchers =
    launchers.data?.rows.filter(
      (launcher) => !activeOnly || ['ready', 'busy', 'recovering'].includes(launcher.status),
    ) ?? []

  if (auth.isLoading) return <Skeleton className={cn('m-3 h-80', className)} />
  if (!auth.isAuthenticated)
    return (
      <WorkbenchSignInPrompt
        description="Launcher 상태를 확인하려면 Account에서 로그인하세요."
        onSignIn={() => onRequestLogin?.()}
      />
    )

  async function runAction(launcherId: string, instanceId: string | null, action: 'cancel' | 'reset' | 'stop-all') {
    const question =
      action === 'stop-all'
        ? '이 Launcher의 모든 실행을 취소하고 프로세스를 종료할까요?'
        : action === 'cancel'
          ? '선택한 실행을 취소할까요?'
          : '선택한 실행의 프로세스를 종료할까요?'
    if (!window.confirm(question)) return
    const key = `${launcherId}:${instanceId ?? '*'}`
    setPending((previous) => new Set(previous).add(key))
    setError(null)
    setMessage(null)
    try {
      if (action === 'stop-all') await dbTables.Launcher.stopAll(launcherId)
      else if (instanceId && action === 'cancel') await dbTables.Launcher.cancelInstance(launcherId, instanceId)
      else if (instanceId) await dbTables.Launcher.resetInstance(launcherId, instanceId)
      setMessage(action === 'cancel' ? '선택한 실행의 취소를 요청했습니다.' : '프로세스 종료를 요청했습니다.')
      await invalidateLauncherMutation(queryClient, auth.queryScope)
    } catch (cause) {
      setError(runtimeErrorMessage(cause, 'Launcher 작업을 요청하지 못했습니다.'))
    } finally {
      setPending((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  async function reconcile() {
    setReconciling(true)
    setError(null)
    setMessage(null)
    try {
      const result = await dbTables.Launcher.reconcile()
      setMessage(`Launcher ${result.launchers}개의 연결 상태를 보정했습니다.`)
      await invalidateLauncherMutation(queryClient, auth.queryScope)
    } catch (cause) {
      setError(runtimeErrorMessage(cause, 'Launcher 상태를 보정하지 못했습니다.'))
    } finally {
      setReconciling(false)
    }
  }

  return (
    <div
      className={cn(
        compact ? 'flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3' : 'mx-auto max-w-7xl space-y-6 px-5 py-10',
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        {compact ? (
          <h2 className="font-semibold">Launchers</h2>
        ) : (
          <PageHeader
            eyebrow="Runtime"
            title="Launchers"
            description="장비 자원과 실행 중인 작업을 확인하고 개별 실행을 관리합니다."
          />
        )}
        <div className="flex gap-2">
          <Button disabled={reconciling} onClick={() => void reconcile()} size="sm" variant="outline">
            <Wrench />
            상태 보정
          </Button>
          <Button disabled={launchers.isFetching} onClick={() => void launchers.refetch()} size="sm" variant="outline">
            <RefreshCw />
            새로고침
          </Button>
        </div>
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">
        Bundled · {bundledSlaveManifests.map((item) => item.name).join(', ') || '없음'}
      </p>
      <label className="flex shrink-0 items-center gap-2 text-sm">
        <input checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} type="checkbox" />
        활성 Launcher만 표시
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {launchers.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {runtimeErrorMessage(launchers.error, 'Launcher 목록을 불러오지 못했습니다.')}
        </p>
      ) : null}
      <ul aria-label="Launcher 목록" className={cn('space-y-3', compact && 'min-h-0 flex-1 overflow-y-auto')}>
        {visibleLaunchers.map((launcher) => {
          const runtime = runtimeByLauncher.get(launcher.id)
          const resources = runtime?.resources
          const instances = runtime?.instances ?? []
          const wait = describeResourceWait(resources?.waiting_reason)
          const allPending = pending.has(`${launcher.id}:*`)
          return (
            <li key={launcher.id}>
              <Card>
                <CardHeader className="gap-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Server className="size-4" />
                      {launcher.launcher_name}
                    </CardTitle>
                    <Badge>{runtime?.recovering ? '연결 복구 중' : launcher.status}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {launcher.slave_app_ids.join(', ')} · {launcher.ip_address ?? '-'} ·{' '}
                    {formatRuntimeDate(launcher.last_heartbeat_at)}
                  </p>
                  <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">CPU 예약 / 예산</dt>
                      <dd>
                        {resources?.cpu_reserved ?? '-'} / {resources?.cpu_total ?? '-'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">RAM 실측 / 예산</dt>
                      <dd>
                        {formatMemory(resources?.ram_used_bytes)} / {formatMemory(resources?.ram_budget_bytes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">RAM 시작용 예약</dt>
                      <dd>{formatMemory(resources?.ram_startup_reserved_bytes)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">GPU 예약 / 장치</dt>
                      <dd>
                        {instances.reduce((sum, item) => sum + (item.allocation?.gpu_devices.length ?? 0), 0)} /{' '}
                        {resources?.gpu_devices?.length ?? '-'}
                      </dd>
                    </div>
                  </dl>
                  {wait ? <p className="text-xs text-muted-foreground">{wait}</p> : null}
                </CardHeader>
                <CardContent className="space-y-2 border-t p-3">
                  {instances.length ? (
                    <ul aria-label={`${launcher.launcher_name} 실행 목록`} className="space-y-2">
                      {instances.map((instance) => {
                        const disabled =
                          allPending || pending.has(`${launcher.id}:${instance.instance_id}`) || !runtime?.connected
                        return (
                          <li className="rounded border p-2 text-xs" key={instance.instance_id}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 space-y-1">
                                <p className="font-medium">
                                  {instance.slave_app_id} · {instance.state} · attempt {instance.attempt_count}
                                </p>
                                <p className="truncate font-mono" title={instance.job_id}>
                                  Job {instance.job_id}
                                </p>
                                <p className="text-muted-foreground">
                                  CPU {instance.allocation?.cpu_cores ?? '-'} · RAM{' '}
                                  {formatMemory(instance.ram_used_bytes)} · GPU{' '}
                                  {instance.allocation?.gpu_devices.length ?? 0}
                                </p>
                              </div>
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  aria-label={`Job ${instance.job_id} 취소`}
                                  disabled={disabled}
                                  onClick={() => void runAction(launcher.id, instance.instance_id, 'cancel')}
                                  size="sm"
                                  variant="destructive"
                                >
                                  <Square />
                                  취소
                                </Button>
                                <Button
                                  aria-label={`Job ${instance.job_id} 프로세스 종료`}
                                  disabled={disabled}
                                  onClick={() => void runAction(launcher.id, instance.instance_id, 'reset')}
                                  size="sm"
                                  variant="outline"
                                >
                                  종료
                                </Button>
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">실행 중인 작업이 없습니다.</p>
                  )}
                  <div className="flex justify-end">
                    <Button
                      disabled={!instances.length || !runtime?.connected || allPending}
                      onClick={() => void runAction(launcher.id, null, 'stop-all')}
                      size="sm"
                      variant="outline"
                    >
                      전체 실행 종료
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
      {!visibleLaunchers.length && !launchers.isError ? (
        <p className="p-4 text-center text-sm text-muted-foreground">
          {launchers.isLoading ? 'Launcher 목록을 불러오는 중입니다.' : '표시할 Launcher가 없습니다.'}
        </p>
      ) : null}
    </div>
  )
}
