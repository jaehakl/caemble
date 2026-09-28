import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { defaultWorkbenchLayoutState, workbenchLayoutLimits } from '../types'
import { ResizableWorkbenchLayout } from './ResizableWorkbenchLayout'

export type WorkbenchShellProps = Readonly<{
  menubar: ReactNode
  ribbon: ReactNode
  left: ReactNode
  viewer: ReactNode
  showViewer?: boolean
  right: ReactNode
  leftWidthRatio?: number
  rightWidthRatio?: number
  onLeftWidthRatioChange?: (ratio: number) => void
  onRightWidthRatioChange?: (ratio: number) => void
  leftLabel?: string
  viewerLabel?: string
  rightLabel?: string
  className?: string
}>

export function WorkbenchShell({
  menubar,
  ribbon,
  left,
  viewer,
  showViewer = true,
  right,
  leftWidthRatio = defaultWorkbenchLayoutState.leftWidthRatio,
  rightWidthRatio = defaultWorkbenchLayoutState.rightWidthRatio,
  onLeftWidthRatioChange,
  onRightWidthRatioChange,
  leftLabel,
  viewerLabel,
  rightLabel,
  className,
}: WorkbenchShellProps) {
  return (
    <div
      className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-background', className)}
      style={{ minWidth: showViewer ? workbenchLayoutLimits.appMinWidthPx : 0 }}
    >
      <header className="shrink-0">
        {menubar}
        {ribbon}
      </header>
      <ResizableWorkbenchLayout
        left={left}
        leftLabel={leftLabel}
        leftWidthRatio={leftWidthRatio}
        onLeftWidthRatioChange={onLeftWidthRatioChange}
        onRightWidthRatioChange={onRightWidthRatioChange}
        right={right}
        rightLabel={rightLabel}
        rightWidthRatio={rightWidthRatio}
        viewer={viewer}
        showViewer={showViewer}
        viewerLabel={viewerLabel}
      />
    </div>
  )
}
