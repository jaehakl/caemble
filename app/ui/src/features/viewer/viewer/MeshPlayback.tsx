import { useEffect, useRef, useState } from 'react'
import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import { meshFrameAtTime } from './meshDeformation'

export function MeshPlayback({
  times,
  unit,
  frame,
  onFrame,
}: {
  times: Float64Array
  unit: UcumUnit
  frame: number
  onFrame: (frame: number) => void
}) {
  const [playing, setPlaying] = useState(false)
  const [repeat, setRepeat] = useState(false)
  const [speed, setSpeed] = useState(1)
  useEffect(() => { setPlaying(false) }, [times])
  const frameRef = useRef(frame)
  frameRef.current = frame
  const duration = times[times.length - 1] - times[0]
  useEffect(() => {
    if (!playing || duration <= 0) return
    const startTime = times[frameRef.current]
    const start = performance.now()
    let animation = 0
    const tick = (now: number) => {
      const elapsed = startTime - times[0] + ((now - start) / 5000) * duration * speed
      if (elapsed >= duration && !repeat) {
        onFrame(times.length - 1)
        setPlaying(false)
        return
      }
      onFrame(meshFrameAtTime(times, times[0] + (repeat ? elapsed % duration : elapsed)))
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [duration, onFrame, playing, repeat, speed, times])
  const seek = (value: number) => {
    setPlaying(false)
    onFrame(value)
  }
  return (
    <div className="my-3 flex flex-wrap items-center gap-3 text-xs" aria-label="Transient playback">
      <button disabled={frame === 0} onClick={() => seek(frame - 1)}>
        이전 프레임
      </button>
      <button
        disabled={times.length < 2}
        onClick={() => {
          if (!playing && frame === times.length - 1) {
            frameRef.current = 0
            onFrame(0)
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
        value={times[frame]}
        disabled={times.length < 2}
        onChange={(event) => seek(meshFrameAtTime(times, Number(event.target.value)))}
      />
      <span>
        {times[frame].toPrecision(5)} {unit} · {frame + 1}/{times.length}
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
