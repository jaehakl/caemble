import { ViewerPlaybackRegistration } from './ViewerPlayback'
import { useViewerComparison, useViewerSetting } from './comparisonSettings'
import { useEffect, useRef } from 'react'
import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import { meshFrameAtTime } from './meshDeformation'

export function MeshPlayback({
  name,
  times,
  unit,
  frame,
  onFrame,
  time,
  onTime,
}: {
  name: string
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
      (comparison && !comparison.controlsOwner)
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
  if (comparison && !comparison.controlsOwner) return null
  return (
    <ViewerPlaybackRegistration
      sources={[
        {
          id: `transient:${name}`,
          label: `${name.replace(/^@visualizations\./u, '')} · Transient`,
          playing,
          repeat,
          speed,
          position: currentTime,
          minimum: times[0],
          maximum: times[times.length - 1],
          step: 'any',
          positionLabel: `${currentTime?.toPrecision(5)} ${unit} · ${frame + 1}/${times.length}`,
          error: times.length < 2 || duration <= 0 ? '시간 표본이 두 개 이상 필요합니다.' : undefined,
          timingLabel: `실제 시간 대비 ${((convertUcumValue(duration, unit, 's', 'Playback speed') / 5) * speed).toPrecision(4)}× · 전체 ${(5 / speed).toPrecision(3)}초`,
          play: () => {
            if (currentTime >= times[times.length - 1]) {
              timeRef.current = times[0]
              if (onTime) onTime(times[0])
              else onFrame(0)
            }
            setPlaying(true)
          },
          pause: () => setPlaying(false),
          seek: (value) => {
            setPlaying(false)
            if (onTime) onTime(value)
            else onFrame(meshFrameAtTime(times, value))
          },
          previous: () => seek(currentTime > times[frame] ? frame : Math.max(0, frame - 1)),
          next: () => seek(Math.min(times.length - 1, frame + 1)),
          onRepeat: setRepeat,
          onSpeed: setSpeed,
        },
      ]}
    />
  )
}
