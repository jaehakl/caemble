import { useQuery } from '@tanstack/react-query'
import { ListChecks, RefreshCw, Square } from 'lucide-react'
import { useState } from 'react'
import { dbTables, type JobState } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { formatRuntimeDate, runtimeErrorMessage } from '@/features/runtime/format'
import { cn } from '@/lib/utils'

const ACTIVE_STATES: readonly JobState[] = ['queued', 'assigned', 'answer_ready', 'running']
const PROGRESS_SUMMARY_LIMIT = 96

export function JobsWorkspace({
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
  const [killingJobId, setKillingJobId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobs = useQuery({
    queryKey: ['runtime', 'jobs', activeOnly],
    queryFn: () => dbTables.Job.list(activeOnly),
    enabled: auth.isAuthenticated,
    refetchInterval: activeOnly ? 10_000 : false,
  })

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
        description="Job 실행 이력을 확인하려면 Account에서 로그인하세요."
        onSignIn={() => onRequestLogin?.()}
      />
    )

  async function killJob(id: string) {
    if (!window.confirm('이 Job을 중단할까요? 실행 중이면 worker에 취소 요청이 전달됩니다.')) return
    setKillingJobId(id)
    setError(null)
    setMessage(null)
    try {
      await dbTables.Job.kill(id)
      setMessage('Job 중단을 요청했습니다.')
      await jobs.refetch()
    } catch (nextError) {
      setError(runtimeErrorMessage(nextError, 'Job을 중단하지 못했습니다.'))
    } finally {
      setKillingJobId(null)
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
            <h2 className="truncate font-semibold">Jobs</h2>
            <p className="truncate text-xs text-muted-foreground">내 Job의 배정 및 실행 상태</p>
          </div>
        ) : (
          <PageHeader
            description="내 Job의 배정, 실행, 완료 상태를 확인하고 활성 작업을 중단합니다."
            eyebrow="Queue"
            title="Jobs"
          />
        )}
        <Button
          disabled={jobs.isFetching}
          onClick={() => void jobs.refetch()}
          size={compact ? 'sm' : 'default'}
          variant="outline"
        >
          <RefreshCw className={jobs.isFetching ? 'animate-spin' : undefined} />
          새로고침
        </Button>
      </div>
      <Card className={cn(compact && 'flex min-h-0 flex-1 flex-col')}>
        <CardHeader className={cn('gap-3 sm:flex-row sm:items-center sm:justify-between', compact && 'shrink-0 p-3')}>
          <CardTitle className={cn('flex items-center gap-2', compact ? 'text-sm' : 'text-lg')}>
            <ListChecks className="size-5 text-primary" />
            실행 이력
          </CardTitle>
          <label className="flex items-center gap-2 text-sm">
            <input checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} type="checkbox" />
            활성 Job만 표시
          </label>
        </CardHeader>
        <CardContent className={cn('border-t pt-4', compact && 'min-h-0 flex-1 overflow-y-auto p-3')}>
          {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
          {message ? <p className="mb-3 text-sm text-emerald-700">{message}</p> : null}
          {compact ? (
            jobs.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Job 목록을 불러오는 중입니다.</p>
            ) : jobs.isError ? (
              <p className="py-10 text-center text-sm text-destructive">
                {runtimeErrorMessage(jobs.error, 'Job 목록을 불러오지 못했습니다.')}
              </p>
            ) : jobs.data?.length ? (
              <ul aria-label="Job 목록" className="space-y-2">
                {jobs.data.map((job) => (
                  <li className="rounded-md border p-3" key={job.id}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{job.handler_type}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">{job.id}</p>
                      </div>
                      <Badge
                        className={ACTIVE_STATES.includes(job.state) ? 'bg-primary text-primary-foreground' : undefined}
                      >
                        {job.state}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">App</dt>
                        <dd className="truncate">{job.slave_app_id}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Launcher</dt>
                        <dd className="truncate font-mono">{job.launcher_id ?? '-'}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">대기 / 실행</dt>
                        <dd>
                          {formatElapsed(job.created_at, job.assigned_at ?? job.finished_at)} /{' '}
                          {formatElapsed(job.started_at, job.finished_at)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">시도</dt>
                        <dd>{job.attempt_count}</dd>
                      </div>
                    </dl>
                    {job.latest_progress ? (
                      <div className="mt-3 rounded bg-muted p-2">
                        <p className="truncate font-mono text-[11px]">
                          {summarizeJobProgress(job.latest_progress.progress)}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {formatRuntimeDate(job.latest_progress.time)}
                        </p>
                      </div>
                    ) : null}
                    {job.last_error ? (
                      <p className="mt-2 text-xs break-words text-destructive">{job.last_error}</p>
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <Button
                        disabled={!ACTIVE_STATES.includes(job.state) || killingJobId === job.id}
                        onClick={() => void killJob(job.id)}
                        size="sm"
                        variant="destructive"
                      >
                        <Square />
                        중단
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">표시할 Job이 없습니다.</p>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Handler</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>진행</TableHead>
                  <TableHead>Launcher</TableHead>
                  <TableHead>대기</TableHead>
                  <TableHead>실행</TableHead>
                  <TableHead>시도</TableHead>
                  <TableHead>오류</TableHead>
                  <TableHead className="text-right">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.isLoading ? (
                  <EmptyRow text="Job 목록을 불러오는 중입니다." />
                ) : jobs.isError ? (
                  <EmptyRow text={runtimeErrorMessage(jobs.error, 'Job 목록을 불러오지 못했습니다.')} />
                ) : jobs.data?.length ? (
                  jobs.data.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <p className="max-w-48 truncate font-mono text-xs">{job.id}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatRuntimeDate(job.created_at)}</p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{job.handler_type}</p>
                        <p className="text-xs text-muted-foreground">{job.slave_app_id}</p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            ACTIVE_STATES.includes(job.state) ? 'bg-primary text-primary-foreground' : undefined
                          }
                        >
                          {job.state}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {job.latest_progress ? (
                          <>
                            <p className="max-w-64 truncate font-mono text-xs">
                              {summarizeJobProgress(job.latest_progress.progress)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatRuntimeDate(job.latest_progress.time)}
                            </p>
                          </>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">{job.launcher_id ?? '-'}</TableCell>
                      <TableCell>{formatElapsed(job.created_at, job.assigned_at ?? job.finished_at)}</TableCell>
                      <TableCell>{formatElapsed(job.started_at, job.finished_at)}</TableCell>
                      <TableCell>{job.attempt_count}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-destructive">
                        {job.last_error ?? '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          disabled={!ACTIVE_STATES.includes(job.state) || killingJobId === job.id}
                          onClick={() => void killJob(job.id)}
                          size="sm"
                          variant="destructive"
                        >
                          <Square />
                          중단
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <EmptyRow text="표시할 Job이 없습니다." />
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function formatElapsed(start: string | null | undefined, end: string | null | undefined) {
  if (!start) return '-'
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '-'
  const seconds = Math.round((endMs - startMs) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function summarizeJobProgress(progress: unknown) {
  let serialized: string | undefined
  try {
    serialized = typeof progress === 'string' ? progress : JSON.stringify(progress)
  } catch {
    serialized = '진행 정보'
  }
  const compact = (serialized ?? String(progress)).replace(/\s+/g, ' ').trim()
  if (!compact) return '-'
  return compact.length <= PROGRESS_SUMMARY_LIMIT ? compact : `${compact.slice(0, PROGRESS_SUMMARY_LIMIT - 1)}…`
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell className="py-12 text-center text-muted-foreground" colSpan={10}>
        {text}
      </TableCell>
    </TableRow>
  )
}
