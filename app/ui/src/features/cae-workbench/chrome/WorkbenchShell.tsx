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
  leftWidthRatio = defaultWorkbenchLayoutState.leftWidthRatio,
  rightWidthRatio = defaultWorkbenchLayoutState.rightWidthRatio,
  bottomHeightRatio = defaultWorkbenchLayoutState.bottomHeightRatio,
  viewerExpanded = defaultWorkbenchLayoutState.viewerExpanded,
  onLeftWidthRatioChange,
  onRightWidthRatioChange,
  onBottomHeightRatioChange,
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
  leftWidthRatio?: number
  rightWidthRatio?: number
  bottomHeightRatio?: number
  viewerExpanded?: boolean
  onLeftWidthRatioChange?: (ratio: number) => void
  onRightWidthRatioChange?: (ratio: number) => void
  onBottomHeightRatioChange?: (ratio: number) => void
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
        bottomHeightRatio={bottomHeightRatio}
        bottomMode={bottomMode}
        viewerExpanded={viewerExpanded}
        left={left}
        leftLabel={leftLabel}
        leftWidthRatio={leftWidthRatio}
        onBottomHeightRatioChange={onBottomHeightRatioChange}
        onLeftWidthRatioChange={onLeftWidthRatioChange}
        onRightWidthRatioChange={onRightWidthRatioChange}
        right={right}
        rightLabel={rightLabel}
        rightWidthRatio={rightWidthRatio}
        viewer={viewer}
        viewerLabel={viewerLabel}
      />
    </div>
  )
}
