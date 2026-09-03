import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'

export function ResizeHandle({
  label,
  orientation,
  value,
  minimum,
  maximum,
  onKeyDown,
  onPointerDown,
}: {
  label: string
  orientation: 'horizontal' | 'vertical'
  value?: number
  minimum?: number
  maximum?: number
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemax={maximum === undefined ? undefined : Math.round(maximum)}
      aria-valuemin={minimum === undefined ? undefined : Math.round(minimum)}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      className={cn(
        'group relative z-10 bg-border/60 transition-colors outline-none hover:bg-primary/35 focus-visible:bg-primary/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute rounded-full bg-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          orientation === 'vertical'
            ? 'inset-y-2 left-1/2 w-0.5 -translate-x-1/2'
            : 'inset-x-2 top-1/2 h-0.5 -translate-y-1/2',
        )}
      />
    </div>
  )
}
