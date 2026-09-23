import { useContext, useEffect, useId, useLayoutEffect, useSyncExternalStore } from 'react'
import { Clock, Pause, Play, Repeat, SkipBack, SkipForward } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ViewerControls, useViewerSetting } from './comparisonSettings'
import { ViewerToolButton } from './ViewerTools'
import { ViewerPlaybackAvailable, ViewerPlaybackContext, type ViewerPlaybackSource } from './viewerPlaybackState'

/** Controllers retain their own clocks; only the selected source is allowed to run. */
export function ViewerPlaybackRegistration({ sources }: { sources: ViewerPlaybackSource[] }) {
  const registry = useContext(ViewerPlaybackContext)!
  const owner = useId()
  const available = useContext(ViewerPlaybackAvailable)
  useLayoutEffect(() => {
    if (!available)
      sources.forEach((source) => {
        if (source.playing) source.pause()
      })
    registry.update(owner, available ? sources : [])
  })
  useLayoutEffect(() => () => registry.remove(owner), [registry, owner])
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
  if (registry.groups.keys().next().value !== owner) return null
  return <ViewerPlaybackMenu />
}

function ViewerPlaybackMenu() {
  const registry = useContext(ViewerPlaybackContext)!
  const [selected, setSelected] = useViewerSetting('playback.source', '', 'workspace')
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
  const sources = [...registry.groups.values()].flat()
  const source =
    sources.find((item) => item.id === selected && !item.disabled) ??
    sources.find((item) => item.preferred && !item.disabled) ??
    sources.find((item) => !item.disabled) ??
    sources[0]
  useEffect(() => {
    if (!source) return
    if (selected !== source.id) {
      sources.forEach((item) => {
        if (item.playing) item.pause()
      })
      setSelected(source.id)
    } else
      sources.forEach((item) => {
        if (item.playing && (item.id !== selected || item.disabled || item.error)) item.pause()
      })
  }, [sources, source, selected, setSelected])
  if (!source) return null
  const unavailable = Boolean(source.disabled || source.error)
  return (
    <ViewerControls placement="data">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ViewerToolButton label="재생 제어" active={source.playing}>
            <Clock />
          </ViewerToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-3 text-xs" data-capture-exclude>
          <section
            aria-label="재생 제어 패널"
            className="grid gap-2 [&_select]:rounded [&_select]:border [&_select]:p-1"
          >
            <label className="grid gap-1">
              재생 대상
              <select
                aria-label="재생 대상"
                value={source.id}
                onChange={(event) => {
                  sources.forEach((item) => item.pause())
                  setSelected(event.target.value)
                }}
              >
                {sources.map((item) => (
                  <option key={item.id} value={item.id} disabled={Boolean(item.disabled)}>
                    {item.label}
                    {item.disabled ? ` · ${item.disabled}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1">
              <ViewerToolButton
                label="이전 프레임"
                disabled={unavailable || source.position <= source.minimum}
                onClick={() => source.previous()}
              >
                <SkipBack />
              </ViewerToolButton>
              <ViewerToolButton
                label={source.playing ? '일시정지' : '재생'}
                active={source.playing}
                disabled={unavailable}
                onClick={() => {
                  sources.forEach((item) => {
                    if (item.id !== source.id) item.pause()
                  })
                  if (source.playing) source.pause()
                  else source.play()
                }}
              >
                {source.playing ? <Pause /> : <Play />}
              </ViewerToolButton>
              <ViewerToolButton
                label="다음 프레임"
                disabled={unavailable || source.position >= source.maximum}
                onClick={() => source.next()}
              >
                <SkipForward />
              </ViewerToolButton>
              <ViewerToolButton label="반복" active={source.repeat} onClick={() => source.onRepeat(!source.repeat)}>
                <Repeat />
              </ViewerToolButton>
            </div>
            <input
              aria-label="재생 위치"
              type="range"
              min={source.minimum}
              max={source.maximum}
              step={source.step}
              value={source.position}
              disabled={unavailable}
              onChange={(event) => source.seek(Number(event.target.value))}
            />
            <output aria-label="재생 시간" className="font-mono tabular-nums">
              {source.positionLabel}
            </output>
            <label>
              재생 속도{' '}
              <select
                aria-label="재생 속도"
                value={source.speed}
                onChange={(event) => source.onSpeed(Number(event.target.value))}
              >
                {[0.25, 0.5, 1, 2, 4].map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            {source.duration !== undefined ? (
              <label>
                재생 구간 (s){' '}
                <input
                  aria-label="재생 구간 (s)"
                  className="w-28 rounded border p-1"
                  type="number"
                  min={0}
                  step="any"
                  value={source.duration}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (Number.isFinite(value) && value > 0) source.onDuration?.(value)
                  }}
                />
              </label>
            ) : null}
            {source.timingLabel ? <span>{source.timingLabel}</span> : null}
            {unavailable ? <p role="status">{source.disabled || source.error}</p> : null}
          </section>
        </DropdownMenuContent>
      </DropdownMenu>
    </ViewerControls>
  )
}
