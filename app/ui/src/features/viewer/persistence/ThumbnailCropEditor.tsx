import { useRef } from 'react'
import type { ThumbnailCrop, ViewerCapture } from './viewerThumbnail'

export function ThumbnailCropEditor({
  capture,
  crop,
  onChange,
  disabled,
}: {
  capture: ViewerCapture
  crop: ThumbnailCrop
  onChange: (crop: ThumbnailCrop) => void
  disabled: boolean
}) {
  const surface = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; crop: ThumbnailCrop; resize: boolean } | null>(null)
  const resize = (start: ThumbnailCrop, requestedWidth: number) => {
    const maximum = Math.min(capture.width - start.x, ((capture.height - start.y) * 4) / 3)
    const minimum = Math.min(40, maximum)
    const width = Math.max(minimum, Math.min(requestedWidth, maximum))
    onChange({ ...start, width, height: (width * 3) / 4 })
  }
  return (
    <div
      ref={surface}
      className="relative w-full touch-none overflow-hidden rounded-md bg-slate-100"
      onPointerMove={(event) => {
        const start = drag.current
        const bounds = surface.current?.getBoundingClientRect()
        if (disabled || !start || !bounds) return
        const dx = ((event.clientX - start.x) * capture.width) / bounds.width
        const dy = ((event.clientY - start.y) * capture.height) / bounds.height
        if (start.resize) resize(start.crop, start.crop.width + dx)
        else
          onChange({
            ...start.crop,
            x: Math.max(0, Math.min(capture.width - start.crop.width, start.crop.x + dx)),
            y: Math.max(0, Math.min(capture.height - start.crop.height, start.crop.y + dy)),
          })
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
    >
      <img src={capture.url} alt="저장 시점 Viewer" className="block w-full" draggable={false} />
      <div
        role="group"
        aria-label="크롭 영역 이동"
        aria-description="방향키로 이동합니다. Shift와 함께 누르면 더 크게 이동합니다."
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_#0008] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-ring"
        style={{
          left: `${(crop.x / capture.width) * 100}%`,
          top: `${(crop.y / capture.height) * 100}%`,
          width: `${(crop.width / capture.width) * 100}%`,
          height: `${(crop.height / capture.height) * 100}%`,
        }}
        onKeyDown={(event) => {
          if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault()
          const step = event.shiftKey ? 10 : 1
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          onChange({
            ...crop,
            x: Math.max(0, Math.min(capture.width - crop.width, crop.x + dx)),
            y: Math.max(0, Math.min(capture.height - crop.height, crop.y + dy)),
          })
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          surface.current?.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY, crop, resize: false }
        }}
      >
        <button
          type="button"
          disabled={disabled}
          aria-label="크롭 영역 크기 조절"
          aria-description="오른쪽·아래 방향키로 확대하고 왼쪽·위 방향키로 축소합니다."
          className="absolute -right-1 -bottom-1 size-5 cursor-se-resize rounded border bg-white focus-visible:outline-2 focus-visible:outline-ring"
          onKeyDown={(event) => {
            event.stopPropagation()
            if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
            resize(crop, crop.width + direction * (event.shiftKey ? 10 : 1))
          }}
          onPointerDown={(event) => {
            event.stopPropagation()
            if (disabled || event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus()
            surface.current?.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX, y: event.clientY, crop, resize: true }
          }}
        />
      </div>
    </div>
  )
}
