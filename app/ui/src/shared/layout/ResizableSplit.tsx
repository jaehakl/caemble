import { useRef, useState, type ReactNode } from 'react'
import { ResizeHandle } from '@/shared/layout/ResizeHandle'

export function ResizableSplit({
  first,
  second,
  vertical = false,
  initial = 0.5,
  label,
}: {
  first: ReactNode
  second: ReactNode
  vertical?: boolean
  initial?: number
  label: string
}) {
  const [ratio, setRatio] = useState(initial)
  const container = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={container}
      className="grid h-full min-h-0 min-w-0 overflow-hidden"
      style={
        vertical
          ? { gridTemplateRows: `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)` }
          : { gridTemplateColumns: `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)` }
      }
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{first}</div>
      <ResizeHandle
        label={label}
        orientation={vertical ? 'horizontal' : 'vertical'}
        minimum={15}
        maximum={85}
        value={Math.round(ratio * 100)}
        onKeyDown={(event) => {
          const lower = vertical ? 'ArrowUp' : 'ArrowLeft'
          const upper = vertical ? 'ArrowDown' : 'ArrowRight'
          if (![lower, upper, 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          setRatio((current) =>
            event.key === 'Home'
              ? 0.15
              : event.key === 'End'
                ? 0.85
                : Math.max(0.15, Math.min(0.85, current + (event.key === lower ? -0.02 : 0.02))),
          )
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          const element = event.currentTarget
          element.setPointerCapture(event.pointerId)
          const move = (pointer: PointerEvent) => {
            const bounds = container.current?.getBoundingClientRect()
            if (!bounds) return
            setRatio(
              Math.max(
                0.15,
                Math.min(
                  0.85,
                  vertical
                    ? (pointer.clientY - bounds.top) / bounds.height
                    : (pointer.clientX - bounds.left) / bounds.width,
                ),
              ),
            )
          }
          const stop = () => {
            element.removeEventListener('pointermove', move)
            element.removeEventListener('lostpointercapture', stop)
          }
          element.addEventListener('pointermove', move)
          element.addEventListener('lostpointercapture', stop)
        }}
      />
      <div className="min-h-0 min-w-0 overflow-hidden">{second}</div>
    </div>
  )
}
