import { useEffect, useRef, useState } from 'react'

export function SpectralPlayback({
  frequency,
  phase,
  onPhase,
}: {
  frequency: number
  phase: number
  onPhase: (degrees: number) => void
}) {
  const [playing, setPlaying] = useState(false)
  const [repeat, setRepeat] = useState(true)
  const [speed, setSpeed] = useState(1)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
    if (!playing || frequency <= 0) return
    const start = performance.now()
    const initialPhase = phaseRef.current
    let animation = 0
    const tick = (now: number) => {
      const next = initialPhase + ((now - start) / 2000) * 360 * speed
      if (next >= 360 && !repeat) {
        onPhase(360)
        setPlaying(false)
        return
      }
      onPhase(next % 360)
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [playing, repeat, speed, frequency, onPhase])
  return (
    <div className="flex flex-wrap items-center gap-3 border-b p-2 text-xs" aria-label="주파수 성분 진동 재생">
      <span>주파수 성분 진동 · 원래 펄스의 시간 이력 아님</span>
      <button
        disabled={frequency <= 0}
        onClick={() => {
          if (!playing && phase >= 360) {
            phaseRef.current = 0
            onPhase(0)
          }
          setPlaying(!playing)
        }}
      >
        {playing ? '일시정지' : '재생'}
      </button>
      <label>
        위상{' '}
        <input
          aria-label="진동 위상"
          type="range"
          min={0}
          max={360}
          step="any"
          value={phase}
          disabled={frequency <= 0}
          onChange={(event) => {
            setPlaying(false)
            onPhase(Number(event.target.value))
          }}
        />{' '}
        {phase.toFixed(1)}°
      </label>
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
      {frequency > 0 ? (
        <span>
          주기 T={(1 / frequency).toPrecision(5)} s · 상대 시간 t={(phase / 360 / frequency).toPrecision(5)} s · 한 주기{' '}
          {2 / speed}초
        </span>
      ) : (
        <span>0 Hz · 정적 실수부</span>
      )}
    </div>
  )
}
