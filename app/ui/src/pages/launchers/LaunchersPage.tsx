import { useQuery } from '@tanstack/react-query'
import { RefreshCw, RotateCcw, Server, Square, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { dbTables } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { formatRuntimeDate, runtimeErrorMessage } from '@/features/runtime/format'
import { bundledSlaveManifests } from '@/features/runtime/manifests'
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
  const [activeOnly, setActiveOnly] = useState(true)
  const [actionLauncherId, setActionLauncherId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const launchers = useQuery({
    queryKey: ['runtime', 'launchers'],
    queryFn: async () => {
      const [rows, runtime] = await Promise.all([dbTables.Launcher.list(), dbTables.Launcher.runtime()])
      return { rows: rows.items, runtime }
    },
    enabled: auth.isAuthenticated,
    refetchInterval: 15_000,
  })
  const runtimeByLauncher = useMemo(
    () => new Map(launchers.data?.runtime.map((item) => [item.launcher_id, item]) ?? []),
    [launchers.data?.runtime],
  )
  const visibleLaunchers =
    launchers.data?.rows.filter((launcher) =>
      activeOnly ? launcher.status === 'ready' || launcher.status === 'busy' : true,
    ) ?? []

  if (auth.isLoading)
    return (
      <div className={cn(compact ? 'h-full space-y-3 p-3' : 'mx-auto max-w-7xl space-y-6 px-5 py-10', className)}>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  if (!auth.isAuthenticated)
    return (
      <WorkbenchSignInPrompt
        description="Launcher 상태를 확인하려면 Account에서 로그인하세요."
        onSignIn={() => onRequestLogin?.()}
      />
    )

  async function runAction(id: string, action: 'cancel' | 'reset') {
    const question =
      action === 'cancel'
        ? '이 Launcher의 현재 Job을 취소할까요?'
        : '이 Launcher의 worker를 재시작할까요? 현재 Job이 있으면 취소됩니다.'
    if (!window.confirm(question)) return
    setActionLauncherId(id)
    setError(null)
    setMessage(null)
    try {
      if (action === 'cancel') await dbTables.Launcher.cancelCurrentJob(id)
      else await dbTables.Launcher.resetWorker(id)
      setMessage(action === 'cancel' ? '현재 Job 취소를 요청했습니다.' : 'Worker reset을 요청했습니다.')
      await launchers.refetch()
    } catch (nextError) {
      setError(runtimeErrorMessage(nextError, 'Launcher 작업을 요청하지 못했습니다.'))
    } finally {
      setActionLauncherId(null)
    }
  }

  async function reconcile() {
    setReconciling(true)
    setError(null)
    setMessage(null)
    try {
      const result = await dbTables.Launcher.reconcile()
      setMessage(`Launcher ${result.launchers}개의 연결 상태를 보정했습니다.`)
      await launchers.refetch()
    } catch (nextError) {
      setError(runtimeErrorMessage(nextError, 'Launcher 상태를 보정하지 못했습니다.'))
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
      <div
        className={cn(
          'flex justify-between gap-3',
          compact ? 'shrink-0 items-center' : 'flex-col sm:flex-row sm:items-start',
        )}
      >
        {compact ? (
          <div className="min-w-0">
            <h2 className="truncate font-semibold">Launchers</h2>
            <p className="truncate text-xs text-muted-foreground">
              Bundled · {bundledSlaveManifests.map((manifest) => manifest.name).join(', ') || '없음'}
            </p>
          </div>
        ) : (
          <PageHeader
            description="연결된 Launcher와 worker, 현재 실행 중인 Job을 확인하고 복구합니다."
            eyebrow="Runtime"
            title="Launchers"
          />
        )}
        <div className="flex gap-2">
          <Button
            disabled={reconciling}
            onClick={() => void reconcile()}
            size={compact ? 'sm' : 'default'}
            variant="outline"
          >
            <Wrench className={reconciling ? 'animate-pulse' : undefined} />
            상태 보정
          </Button>
          <Button
            disabled={launchers.isFetching}
            onClick={() => void launchers.refetch()}
            size={compact ? 'sm' : 'default'}
            variant="outline"
          >
            <RefreshCw className={launchers.isFetching ? 'animate-spin' : undefined} />
            새로고침
          </Button>
        </div>
      </div>

      <Card className={cn(compact && 'flex min-h-0 flex-1 flex-col')}>
        <CardHeader className={cn('gap-3 sm:flex-row sm:items-center sm:justify-between', compact && 'shrink-0 p-3')}>
          <div>
            <CardTitle className={cn('flex items-center gap-2', compact ? 'text-sm' : 'text-lg')}>
              <Server className="size-5 text-primary" />
              Launcher 상태
            </CardTitle>
            {!compact ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Bundled apps · {bundledSlaveManifests.map((manifest) => manifest.name).join(', ') || '없음'}
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} type="checkbox" />
            활성 Launcher만 표시
          </label>
        </CardHeader>
        <CardContent className={cn('border-t pt-4', compact && 'min-h-0 flex-1 overflow-y-auto p-3')}>
          {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
          {message ? <p className="mb-3 text-sm text-emerald-700">{message}</p> : null}
          {compact ? (
            launchers.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Launcher 목록을 불러오는 중입니다.</p>
            ) : launchers.isError ? (
              <p className="py-10 text-center text-sm text-destructive">
                {runtimeErrorMessage(launchers.error, 'Launcher 목록을 불러오지 못했습니다.')}
              </p>
            ) : visibleLaunchers.length ? (
              <ul aria-label="Launcher 목록" className="space-y-2">
                {visibleLaunchers.map((launcher) => {
                  const runtime = runtimeByLauncher.get(launcher.id)
                  return (
                    <li className="rounded-md border p-3" key={launcher.id}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{launcher.launcher_name}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">{launcher.id}</p>
                        </div>
                        <Badge
                          className={launcher.status === 'ready' ? 'bg-primary text-primary-foreground' : undefined}
                        >
                          {launcher.status}
                        </Badge>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Worker</dt>
                          <dd className="truncate">
                            {runtime?.worker_status ?? 'offline'} · {runtime?.loaded_slave_app_id ?? '-'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Apps</dt>
                          <dd className="truncate">{launcher.slave_app_ids.join(', ') || '-'}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">현재 Job</dt>
                          <dd className="truncate font-mono">{runtime?.current_job_id ?? '-'}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Heartbeat</dt>
                          <dd className="truncate">{formatRuntimeDate(launcher.last_heartbeat_at)}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">IP</dt>
                          <dd className="truncate">{launcher.ip_address ?? '-'}</dd>
                        </div>
                      </dl>
                      <div className="mt-3 flex justify-end gap-2">
                        <Button
                          disabled={!runtime?.current_job_id || actionLauncherId === launcher.id}
                          onClick={() => void runAction(launcher.id, 'cancel')}
                          size="sm"
                          variant="destructive"
                        >
                          <Square />
                          취소
                        </Button>
                        <Button
                          disabled={!runtime || runtime.resetting || actionLauncherId === launcher.id}
                          onClick={() => void runAction(launcher.id, 'reset')}
                          size="sm"
                          variant="outline"
                        >
                          <RotateCcw />
                          Reset
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">표시할 Launcher가 없습니다.</p>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>Apps</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>현재 Job</TableHead>
                  <TableHead>Heartbeat</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead className="text-right">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {launchers.isLoading ? (
                  <EmptyRow text="Launcher 목록을 불러오는 중입니다." />
                ) : launchers.isError ? (
                  <EmptyRow text={runtimeErrorMessage(launchers.error, 'Launcher 목록을 불러오지 못했습니다.')} />
                ) : visibleLaunchers.length ? (
                  visibleLaunchers.map((launcher) => {
                    const runtime = runtimeByLauncher.get(launcher.id)
                    return (
                      <TableRow key={launcher.id}>
                        <TableCell>
                          <p className="font-medium">{launcher.launcher_name}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">{launcher.id}</p>
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={launcher.status === 'ready' ? 'bg-primary text-primary-foreground' : undefined}
                          >
                            {launcher.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{launcher.slave_app_ids.join(', ') || '-'}</TableCell>
                        <TableCell>
                          <Badge className="border bg-transparent">{runtime?.worker_status ?? 'offline'}</Badge>
                          <p className="mt-1 text-xs text-muted-foreground">{runtime?.loaded_slave_app_id ?? '-'}</p>
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-xs">
                          {runtime?.current_job_id ?? '-'}
                        </TableCell>
                        <TableCell>{formatRuntimeDate(launcher.last_heartbeat_at)}</TableCell>
                        <TableCell>{launcher.ip_address ?? '-'}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              disabled={!runtime?.current_job_id || actionLauncherId === launcher.id}
                              onClick={() => void runAction(launcher.id, 'cancel')}
                              size="sm"
                              variant="destructive"
                            >
                              <Square />
                              취소
                            </Button>
                            <Button
                              disabled={!runtime || runtime.resetting || actionLauncherId === launcher.id}
                              onClick={() => void runAction(launcher.id, 'reset')}
                              size="sm"
                              variant="outline"
                            >
                              <RotateCcw />
                              Reset
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <EmptyRow text="표시할 Launcher가 없습니다." />
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell className="py-12 text-center text-muted-foreground" colSpan={8}>
        {text}
      </TableCell>
    </TableRow>
  )
}
