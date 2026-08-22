import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RuntimeActivityLevel, RuntimeActivitySource } from './types'
import type { RuntimeConsoleStore } from './store'

const sourceLabels: Record<RuntimeActivitySource, string> = {
  cad: 'CAD',
  gpstation: 'GPStation',
  cae: 'CAE',
}

export function RuntimeConsoleView({ store }: { store: RuntimeConsoleStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [source, setSource] = useState<RuntimeActivitySource | 'all'>('all')
  const [level, setLevel] = useState<RuntimeActivityLevel | 'all'>('all')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const events = useMemo(
    () =>
      snapshot.events.filter((event) => {
        if (source !== 'all' && event.source !== source) return false
        if (level !== 'all' && event.level !== level) return false
        if (!normalizedQuery) return true
        return [
          event.source,
          event.level,
          event.phase,
          event.message,
          event.jobId,
          event.runId,
          ...Object.entries(event.details ?? {}).flat(),
        ]
          .filter((value) => value !== undefined && value !== null)
          .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery))
      }),
    [level, normalizedQuery, snapshot.events, source],
  )

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [autoScroll, events])

  return (
    <section aria-label="Runtime Console" className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
        <select
          aria-label="Source 필터"
          className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2"
          value={source}
          onChange={(event) => setSource(event.target.value as RuntimeActivitySource | 'all')}
        >
          <option value="all">모든 Source</option>
          <option value="cad">CAD</option>
          <option value="gpstation">GPStation</option>
          <option value="cae">CAE</option>
        </select>
        <select
          aria-label="Level 필터"
          className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2"
          value={level}
          onChange={(event) => setLevel(event.target.value as RuntimeActivityLevel | 'all')}
        >
          <option value="all">모든 Level</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
        <input
          aria-label="Runtime Console 검색"
          className="h-8 min-w-44 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          placeholder="메시지, phase, ID 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap">
          <input checked={autoScroll} type="checkbox" onChange={(event) => setAutoScroll(event.target.checked)} />
          자동 스크롤
        </label>
        <span className="text-zinc-400">
          {snapshot.events.length} · {(snapshot.byteLength / 1024).toFixed(1)} KiB
        </span>
        <Button
          aria-label="Runtime Console 지우기"
          className="text-zinc-200 hover:bg-zinc-800 hover:text-white"
          disabled={!snapshot.events.length}
          size="sm"
          type="button"
          variant="ghost"
          onClick={store.clear}
        >
          <Trash2 aria-hidden="true" />
          지우기
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs" role="log" aria-live="polite">
        {events.length ? (
          <ol aria-label="Runtime Console 이벤트" className="divide-y divide-zinc-900">
            {events.map((event) => (
              <li className="grid gap-1 px-3 py-2 sm:grid-cols-[6.5rem_5.5rem_minmax(0,1fr)]" key={event.id}>
                <time className="text-zinc-500" dateTime={new Date(event.timestamp).toISOString()}>
                  {new Date(event.timestamp).toISOString().slice(11, 23)}
                </time>
                <span
                  className={
                    event.level === 'error'
                      ? 'text-red-400'
                      : event.level === 'warning'
                        ? 'text-amber-300'
                        : 'text-sky-300'
                  }
                >
                  {sourceLabels[event.source]} · {event.level}
                </span>
                <div className="min-w-0">
                  <p className="break-words">
                    {event.phase ? <span className="mr-2 text-zinc-500">[{event.phase}]</span> : null}
                    {event.message}
                  </p>
                  {event.progress !== undefined ? (
                    <div className="mt-1 flex items-center gap-2 text-zinc-400">
                      <progress
                        aria-label={`${event.message} 진행률`}
                        className="h-1.5 max-w-44 flex-1 accent-orange-500"
                        max={1}
                        value={event.progress}
                      />
                      <span>{Math.round(event.progress * 100)}%</span>
                    </div>
                  ) : null}
                  {event.jobId || event.runId ? (
                    <p className="mt-1 break-all text-zinc-500">
                      {[event.jobId ? `job=${event.jobId}` : null, event.runId ? `run=${event.runId}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  ) : null}
                  {event.details ? (
                    <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-500">
                      {Object.entries(event.details).map(([key, value]) => (
                        <div className="flex gap-1" key={key}>
                          <dt>{key}=</dt>
                          <dd className="break-all">{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-3 py-6 text-center text-zinc-500">
            {snapshot.events.length ? '필터와 일치하는 이벤트가 없습니다.' : 'Runtime 이벤트가 없습니다.'}
          </p>
        )}
        <div ref={endRef} />
      </div>
    </section>
  )
}
