import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkbenchSectionId } from '../types'
import type { WorkbenchAction } from './actions'

export type WorkbenchRibbonPanel = Readonly<{
  sectionId: WorkbenchSectionId
  label: string
  content: ReactNode
}>

export function WorkbenchRibbonAction({ action, className }: { action: WorkbenchAction; className?: string }) {
  const accessibleLabel =
    action.disabled && action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-disabled={action.disabled || undefined}
          aria-label={accessibleLabel}
          aria-pressed={action.pressed}
          className={cn(
            'flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent',
            action.primary && 'bg-primary text-primary-foreground hover:bg-primary/90',
            action.pressed && 'bg-accent text-accent-foreground ring-1 ring-primary/35',
            className,
          )}
          onClick={() => {
            if (!action.disabled) action.onSelect()
          }}
          type="button"
        >
          <span aria-hidden="true" className="flex items-center justify-center [&_svg]:size-4">
            {action.icon}
          </span>
          <span className="text-xs leading-4 font-medium whitespace-nowrap">{action.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>{action.label}</div>
        {action.shortcut ? <div className="opacity-70">{action.shortcut}</div> : null}
        {action.disabledReason ? <div className="opacity-70">{action.disabledReason}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorkbenchRibbonActions({
  actions,
  className,
}: {
  actions: readonly WorkbenchAction[]
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {actions.map((action) => (
        <WorkbenchRibbonAction action={action} key={action.id} />
      ))}
    </div>
  )
}

export function WorkbenchRibbonGroup({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'flex shrink-0 flex-col justify-center gap-2 border-r border-border/70 px-3 py-1 last:border-r-0',
        className,
      )}
    >
      <div className="flex min-h-10 items-center gap-2">{children}</div>
      <h2 className="text-[10px] font-medium tracking-wide text-muted-foreground">{label}</h2>
    </section>
  )
}

export function WorkbenchRibbon({
  activeSectionId,
  panels,
  emptyContent = '사용할 수 있는 리본 명령이 없습니다.',
  className,
}: {
  activeSectionId: WorkbenchSectionId
  panels: readonly WorkbenchRibbonPanel[]
  emptyContent?: ReactNode
  className?: string
}) {
  const activePanel = panels.find((panel) => panel.sectionId === activeSectionId)

  return (
    <section
      aria-label={activePanel ? `${activePanel.label} 리본` : 'CAE 리본'}
      className={cn('overflow-x-auto border-b bg-muted/20 px-1 py-1', className)}
    >
      {activePanel ? (
        <div className="flex min-w-max items-stretch">{activePanel.content}</div>
      ) : (
        <div className="flex min-h-[72px] items-center text-sm text-muted-foreground">{emptyContent}</div>
      )}
    </section>
  )
}
