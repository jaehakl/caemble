import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/features/auth/use-auth'
import { caeBatches } from '@/api/cae'
import type { CaeBatch } from '@/contracts/api/cae'
import { Button } from '@/components/ui/button'
import { useCaeBatches } from './CaeBatchProvider'
import { describeCaeProgress } from './progress'
import { resumeBrowserUpload } from './resumeUpload'

export function CaeBatchPanel() {
  const { queryScope } = useAuth()
  // Account changes also discard local state from outstanding panel requests.
  return <BatchPanel key={queryScope} />
}

function BatchPanel() {
  const { batches, connected, error, inspectedBatchId, loading, refresh, update, readPage, withProgress } =
    useCaeBatches()
  const [selected, setSelected] = useState<string | null>(null)
  const selectionRef = useRef(selected)
  selectionRef.current = selected
  const [detail, setDetail] = useState<CaeBatch | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const uploadRef = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const [uploadProgress, setUploadProgress] = useState<{ batchId: string; completed: number; total: number } | null>(
    null,
  )
  const batch = batches.find((item) => item.id === selected)
  const visibleJobs = detail ? withProgress(detail).jobs : []
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      uploadRef.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!inspectedBatchId) return
    setSelected(inspectedBatchId)
    setDetail(null)
    setOffset(0)
  }, [inspectedBatchId])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    void readPage(selected, { offset, limit: 100 })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setActionError(cause instanceof Error ? cause.message : '작업 상세를 불러오지 못했습니다.')
      })
    return () => controller.abort()
  }, [batch?.last_event_id, offset, selected, readPage])

  async function act(operation: () => Promise<CaeBatch>) {
    const selectionAtStart = selected
    setBusy(true)
    setActionError(null)
    try {
      const value = await operation()
      if (!mounted.current) return
      update(value)
      if (selectionRef.current === value.id) {
        setDetail(value)
        setOffset(0)
      }
    } catch (cause) {
      if (mounted.current && selectionRef.current === selectionAtStart)
        setActionError(cause instanceof Error ? cause.message : '작업 요청에 실패했습니다.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function resume(value: CaeBatch) {
    const controller = new AbortController()
    uploadRef.current = controller
    setBusy(true)
    setActionError(null)
    setUploadProgress({ batchId: value.id, completed: value.uploaded_count, total: value.total })
    try {
      const completed = await resumeBrowserUpload(value, controller.signal, (count, total) => {
        if (!controller.signal.aborted)
          setUploadProgress({ batchId: value.id, completed: Math.max(value.uploaded_count, count), total })
      })
      if (controller.signal.aborted || !mounted.current) return
      update(completed)
      if (selectionRef.current === completed.id) {
        setDetail(completed)
        setOffset(0)
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current && selectionRef.current === value.id) {
        setActionError(cause instanceof Error ? cause.message : '업로드를 재개하지 못했습니다.')
      }
    } finally {
      if (mounted.current && uploadRef.current === controller) {
        uploadRef.current = null
        setBusy(false)
        setUploadProgress(null)
      }
    }
  }

  return (
    <section aria-label="CAE Jobs" className="h-full space-y-4 overflow-auto p-4">
      <h2 className="font-semibold">CAE Jobs</h2>
      {!batches.length && !loading ? (
        <p className="text-sm text-muted-foreground">등록된 CAE 작업이 없습니다.</p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="text-muted-foreground">
          {connected ? '실시간 연결됨' : loading ? '불러오는 중…' : '연결 복구 중…'} · 브라우저를 닫아도 접수된 CAE
          작업은 계속됩니다.
        </p>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
          새로고침
        </Button>
      </div>
      {error || actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError ?? error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <ul aria-label="CAE batch 목록" className="max-h-[55vh] space-y-2 overflow-y-auto">
          {batches.map((item) => (
            <li key={item.id}>
              <button
                className={`w-full rounded border p-3 text-left text-sm ${selected === item.id ? 'border-primary bg-muted' : ''}`}
                onClick={() => {
                  setSelected(item.id)
                  if (selected !== item.id) setDetail(null)
                  setOffset(0)
                  setActionError(null)
                }}
              >
                <p className="font-medium">
                  {item.preflight ? 'Preflight' : `Experiment #${item.experiment_id}`} · {item.total}회{' '}
                  {item.mode === 'generate' ? 'Generate & Run' : 'Run'}
                </p>
                <p className="mt-1">
                  {item.state === 'uploading'
                    ? `업로드 ${uploadProgress?.batchId === item.id ? uploadProgress.completed : item.uploaded_count} / ${item.total}`
                    : `${item.state} · 성공 ${item.succeeded} / 실패 ${item.failed} / 취소 ${item.cancelled}`}
                </p>
                <progress
                  className="mt-2 h-2 w-full"
                  max={item.total}
                  aria-label={`Batch ${item.id} ${item.state === 'uploading' ? '업로드' : '실행'} 진행률`}
                  value={
                    item.state === 'uploading'
                      ? uploadProgress?.batchId === item.id
                        ? uploadProgress.completed
                        : item.uploaded_count
                      : item.succeeded + item.failed + item.cancelled
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(item.created_at).toLocaleString()}
                  {item.finished_at && item.read_event_id < item.last_event_id ? ' · 새 알림' : ''}
                </p>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 space-y-3">
          {detail && batch && detail.id === batch.id ? (
            <>
              <p className="font-mono text-xs break-all text-muted-foreground">{detail.id}</p>
              <div className="flex gap-2">
                {detail.state === 'uploading' && !detail.preflight ? (
                  <Button size="sm" disabled={busy} onClick={() => void resume(detail)}>
                    {uploadProgress?.batchId === detail.id ? '업로드 재개 중…' : '업로드 재개'}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || detail.failed === 0 || detail.preflight}
                  onClick={() => void act(() => caeBatches.retry(detail.id))}
                >
                  실패한 작업 재시도
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={(busy && uploadProgress?.batchId !== detail.id) || Boolean(detail.finished_at)}
                  onClick={() => {
                    uploadRef.current?.abort()
                    uploadRef.current = null
                    setUploadProgress(null)
                    void act(() => caeBatches.cancel(detail.id))
                  }}
                >
                  Batch 취소
                </Button>
              </div>
              {detail.state === 'uploading' && !detail.preflight ? (
                <p className="text-sm text-muted-foreground">
                  이 브라우저에 저장된 빌드 결과로 남은 업로드를 이어갑니다. 업로드가 모두 끝나면 작업이 시작됩니다.
                </p>
              ) : null}
              <ul aria-label="CAE 개별 작업" className="max-h-[42vh] space-y-2 overflow-y-auto">
                {visibleJobs.map((job) => {
                  const progress = describeCaeProgress(job.progress)
                  return (
                    <li className="rounded border p-2 text-sm" key={job.id}>
                      <p>
                        시도 {job.index} · {job.state}
                        {job.measurement_id ? ` · Measurement #${job.measurement_id}` : ''}
                      </p>
                      {progress ? (
                        <p className="mt-1 text-xs break-words text-muted-foreground">{progress.message}</p>
                      ) : null}
                      {progress?.fraction !== undefined ? (
                        <progress
                          aria-label={`작업 ${job.index} 진행률`}
                          className="mt-1 h-2 w-full"
                          max={1}
                          value={progress.fraction}
                        />
                      ) : null}
                      {job.last_error ? (
                        <p className="mt-1 text-xs break-words text-destructive">{job.last_error}</p>
                      ) : null}
                      {job.state === 'failed' && !detail.preflight ? (
                        <Button
                          className="mt-2"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void act(() => caeBatches.retry(detail.id, [job.id]))}
                        >
                          이 작업 재시도
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              <div className="flex items-center justify-between text-xs">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset === 0}
                  onClick={() => setOffset((value) => Math.max(0, value - 100))}
                >
                  이전
                </Button>
                <span>
                  {offset + 1}–{offset + detail.jobs.length} / {detail.jobs_total ?? detail.created_count}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offset + detail.jobs.length >= (detail.jobs_total ?? detail.created_count)}
                  onClick={() => setOffset((value) => value + 100)}
                >
                  다음
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                CalculationData 후처리와 Prediction 반복은 열린 브라우저에서 실행됩니다. 재접속 후 필요한 후처리는
                Calculation의 Missing 실행을 사용하세요.
              </p>
            </>
          ) : (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {selected ? '작업을 불러오는 중…' : '확인할 batch를 선택하세요.'}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
