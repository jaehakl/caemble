import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronRight, Trash2 } from 'lucide-react'
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
  const [expandedEventIds, setExpandedEventIds] = useState<ReadonlySet<string>>(() => new Set())
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
            {events.map((event, index) => {
              const expanded = expandedEventIds.has(event.id)
              const contentId = `runtime-console-event-${index}`
              return (
                <li
                  className="grid grid-cols-[1.25rem_5.5rem_minmax(0,1fr)] items-start gap-1 px-3 py-2"
                  key={event.id}
                >
                  <button
                    aria-controls={contentId}
                    aria-expanded={expanded}
                    aria-label={`${event.message} 이벤트 ${expanded ? '접기' : '펼치기'}`}
                    className="mt-px flex size-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:outline-none"
                    type="button"
                    onClick={() =>
                      setExpandedEventIds((current) => {
                        const next = new Set(current)
                        if (next.has(event.id)) next.delete(event.id)
                        else next.add(event.id)
                        return next
                      })
                    }
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                  <span className="whitespace-nowrap text-zinc-400">{sourceLabels[event.source]}</span>
                  <div className="flex min-w-0 items-start gap-2" id={contentId}>
                    <p
                      className={
                        expanded
                          ? 'min-w-0 flex-1 break-words whitespace-pre-wrap'
                          : 'min-w-0 flex-1 truncate whitespace-nowrap'
                      }
                    >
                      {event.phase ? <span className="mr-2 text-zinc-500">[{event.phase}]</span> : null}
                      {event.message}
                    </p>
                    {event.progress !== undefined ? (
                      <div className="flex shrink-0 items-center gap-2 text-zinc-400">
                        <progress
                          aria-label={`${event.message} 진행률`}
                          className="h-1.5 w-28 accent-orange-500"
                          max={1}
                          value={event.progress}
                        />
                        <span>{Math.round(event.progress * 100)}%</span>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
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
