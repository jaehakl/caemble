import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type WorkbenchRibbonPanel = Readonly<{
  tabId: string
  label: string
  content: ReactNode
}>

export function WorkbenchRibbon({
  activeTabId,
  panels,
  emptyContent = '활성 Editor 탭이 없습니다.',
  className,
}: {
  activeTabId: string | null
  panels: readonly WorkbenchRibbonPanel[]
  emptyContent?: ReactNode
  className?: string
}) {
  const activePanel = panels.find((panel) => panel.tabId === activeTabId)

  return (
    <section
      aria-label={activePanel ? `${activePanel.label} 리본` : 'CAE 리본'}
      className={cn('min-h-16 overflow-x-auto border-b bg-background px-3 py-2', className)}
    >
      {activePanel ? (
        activePanel.content
      ) : (
        <div className="flex min-h-12 items-center text-sm text-muted-foreground">{emptyContent}</div>
      )}
    </section>
  )
}
