import type { CalculationLogEntry } from '@/lib/calculation'
import type { CalculationPreviewState } from './CalculationOutputChart'

export function CalculationLogPanel({
  logs,
  preview,
}: {
  logs: readonly CalculationLogEntry[]
  preview: CalculationPreviewState
}) {
  const truncated = logs.some((entry) => entry.message === '[Calculation console.log output truncated]')
  return (
    <section aria-label="Calculation console.log" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs">
        <h2 className="font-semibold">
          console.log <span className="font-normal text-muted-foreground">{logs.length}개</span>
        </h2>
        <span role="status" className="text-muted-foreground">
          {preview.status === 'loading'
            ? '갱신 중…'
            : preview.status === 'error'
              ? '실행 오류'
              : preview.status === 'success'
                ? '갱신 완료'
                : '실행 대기'}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {truncated ? (
          <p role="status" className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900">
            출력 제한에 도달해 이후 로그는 생략됐습니다.
          </p>
        ) : null}
        {logs.length ? (
          <ol className="divide-y">
            {logs.map((entry, index) => (
              <li key={`${entry.requestId}:${entry.sequence}`} className="flex gap-3 px-3 py-2 text-xs">
                <span className="shrink-0 text-muted-foreground select-none">{index + 1}</span>
                <pre className="min-w-0 font-mono break-words whitespace-pre-wrap">{entry.message}</pre>
              </li>
            ))}
          </ol>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            {preview.status === 'loading' ? '현재 실행의 로그를 기다리는 중입니다.' : '표시할 console.log가 없습니다.'}
          </p>
        )}
        {preview.status === 'error' ? (
          <p role="alert" className="border-t p-3 text-xs break-words whitespace-pre-wrap text-destructive">
            {preview.message}
          </p>
        ) : null}
      </div>
    </section>
  )
}
