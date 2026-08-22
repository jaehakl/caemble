import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { defaultWorkbenchLayoutState, workbenchLayoutLimits, type BottomDockMode } from '../types'
import { ResizableWorkbenchLayout } from './ResizableWorkbenchLayout'

export function WorkbenchShell({
  menubar,
  ribbon,
  left,
  viewer,
  right,
  bottom,
  bottomMode,
  leftWidthPx = defaultWorkbenchLayoutState.leftWidthPx,
  rightWidthPx = defaultWorkbenchLayoutState.rightWidthPx,
  bottomHeightPx = defaultWorkbenchLayoutState.bottomHeightPx,
  onLeftWidthChange,
  onRightWidthChange,
  onBottomHeightChange,
  leftLabel,
  viewerLabel,
  rightLabel,
  className,
}: {
  menubar: ReactNode
  ribbon: ReactNode
  left: ReactNode
  viewer: ReactNode
  right: ReactNode
  bottom: ReactNode
  bottomMode: BottomDockMode
  leftWidthPx?: number
  rightWidthPx?: number
  bottomHeightPx?: number
  onLeftWidthChange?: (widthPx: number) => void
  onRightWidthChange?: (widthPx: number) => void
  onBottomHeightChange?: (heightPx: number) => void
  leftLabel?: string
  viewerLabel?: string
  rightLabel?: string
  className?: string
}) {
  return (
    <div
      className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-background', className)}
      style={{ minWidth: workbenchLayoutLimits.appMinWidthPx }}
    >
      <header className="shrink-0">
        {menubar}
        {ribbon}
      </header>
      <ResizableWorkbenchLayout
        bottom={bottom}
        bottomHeightPx={bottomHeightPx}
        bottomMode={bottomMode}
        left={left}
        leftLabel={leftLabel}
        leftWidthPx={leftWidthPx}
        onBottomHeightChange={onBottomHeightChange}
        onLeftWidthChange={onLeftWidthChange}
        onRightWidthChange={onRightWidthChange}
        right={right}
        rightLabel={rightLabel}
        rightWidthPx={rightWidthPx}
        viewer={viewer}
        viewerLabel={viewerLabel}
      />
    </div>
  )
}
