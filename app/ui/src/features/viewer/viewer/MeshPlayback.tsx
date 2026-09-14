import { useViewerComparison, useViewerSetting } from './comparisonSettings'
import { useEffect, useRef } from 'react'
import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import { meshFrameAtTime } from './meshDeformation'

export function MeshPlayback({
  times,
  unit,
  frame,
  onFrame,
  time,
  onTime,
}: {
  times: Float64Array
  unit: UcumUnit
  frame: number
  onFrame: (frame: number) => void
  time?: number
  onTime?: (time: number) => void
}) {
  const comparison = useViewerComparison()
  const [playing, setPlaying] = useViewerSetting('meshPlayback.playing', false)
  const [repeat, setRepeat] = useViewerSetting('meshPlayback.repeat', false)
  const [speed, setSpeed] = useViewerSetting('meshPlayback.speed', 1)
  useEffect(() => {
    if (!comparison) setPlaying(false)
  }, [times, comparison, setPlaying])
  const currentTime = time ?? times[frame]
  const timeRef = useRef(currentTime)
  timeRef.current = currentTime
  const duration = times[times.length - 1] - times[0]
  useEffect(() => {
    if (
      !playing ||
      duration <= 0 ||
      !Number.isFinite(timeRef.current) ||
      comparison?.suspended ||
      (onTime && comparison && !comparison.controlsOwner)
    )
      return
    const startTime = timeRef.current
    const start = performance.now()
    let animation = 0
    const tick = (now: number) => {
      const elapsed = startTime - times[0] + ((now - start) / 5000) * duration * speed
      if (elapsed >= duration && !repeat) {
        if (onTime) onTime(times[times.length - 1])
        else onFrame(times.length - 1)
        setPlaying(false)
        return
      }
      const next = times[0] + (repeat ? elapsed % duration : elapsed)
      if (onTime) onTime(next)
      else onFrame(meshFrameAtTime(times, next))
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [duration, onFrame, onTime, playing, repeat, speed, times, comparison, setPlaying])
  const seek = (value: number) => {
    setPlaying(false)
    if (onTime) onTime(times[value])
    else onFrame(value)
  }
  return (
    <div className="my-3 flex flex-wrap items-center gap-3 text-xs" aria-label="Transient playback">
      <button disabled={currentTime <= times[0]} onClick={() => seek(currentTime > times[frame] ? frame : frame - 1)}>
        이전 프레임
      </button>
      <button
        disabled={times.length < 2}
        onClick={() => {
          if (!playing && currentTime >= times[times.length - 1]) {
            timeRef.current = times[0]
            if (onTime) onTime(times[0])
            else onFrame(0)
          }
          setPlaying(!playing)
        }}
      >
        {playing ? '일시정지' : '재생'}
      </button>
      <button disabled={frame === times.length - 1} onClick={() => seek(frame + 1)}>
        다음 프레임
      </button>
      <input
        aria-label="Animation time"
        type="range"
        min={times[0]}
        max={times[times.length - 1]}
        step="any"
        value={currentTime}
        disabled={times.length < 2}
        onChange={(event) => {
          if (onTime) {
            setPlaying(false)
            onTime(Number(event.target.value))
          } else seek(meshFrameAtTime(times, Number(event.target.value)))
        }}
      />
      <span>
        {currentTime?.toPrecision(5)} {unit} · {frame + 1}/{times.length}
      </span>
      <label>
        <input type="checkbox" checked={repeat} onChange={(event) => setRepeat(event.target.checked)} /> 반복
      </label>
      <label>
        재생 속도{' '}
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {[0.25, 0.5, 1, 2, 4].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </label>
      <span>
        실제 시간 대비 {((convertUcumValue(duration, unit, 's', 'Playback speed') / 5) * speed).toPrecision(4)}× · 전체{' '}
        {(5 / speed).toPrecision(3)}초
      </span>
    </div>
  )
}
