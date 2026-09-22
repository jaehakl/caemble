import type { ComponentProps, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkbenchSectionId } from '../types'
import type { WorkbenchAction } from './actions'

export type WorkbenchRibbonPanel = Readonly<{
  sectionId: WorkbenchSectionId
  label: string
  content: ReactNode
}>

export function WorkbenchRibbonButton({
  icon,
  label,
  size = 'small',
  className,
  ...props
}: ComponentProps<'button'> & { icon?: ReactNode; label: ReactNode; size?: 'small' | 'large' }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'flex shrink-0 items-center rounded-sm text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent',
        size === 'large' ? 'h-[72px] w-24 flex-col justify-center gap-1 px-1' : 'h-6 justify-start gap-1.5 px-2',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center',
            size === 'large' ? '[&_svg]:size-7' : '[&_svg]:size-4',
          )}
        >
          {icon}
        </span>
      ) : null}
      <span
        className={cn(
          'text-xs leading-4',
          size === 'large' ? 'max-w-full text-center whitespace-normal' : 'whitespace-nowrap',
        )}
      >
        {label}
      </span>
    </button>
  )
}

export function WorkbenchRibbonAction({
  action,
  size = 'small',
  className,
}: {
  action: WorkbenchAction
  size?: 'small' | 'large'
  className?: string
}) {
  const accessibleLabel =
    action.disabled && action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkbenchRibbonButton
          aria-disabled={action.disabled || undefined}
          aria-label={accessibleLabel}
          aria-pressed={action.pressed}
          className={cn(
            action.primary && 'text-primary',
            action.pressed && 'bg-accent text-accent-foreground ring-1 ring-primary/35',
            className,
          )}
          icon={action.icon}
          label={action.label}
          size={size}
          onClick={() => {
            if (!action.disabled) action.onSelect()
          }}
        />
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
  size = 'small',
  className,
}: {
  actions: readonly WorkbenchAction[]
  size?: 'small' | 'large'
  className?: string
}) {
  return (
    <div
      className={cn(
        size === 'large'
          ? 'flex h-[72px] items-center gap-0.5'
          : 'grid h-[72px] grid-flow-col grid-rows-3 items-center gap-x-1',
        className,
      )}
    >
      {actions.map((action) => (
        <WorkbenchRibbonAction action={action} size={size} key={action.id} />
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
      className={cn('flex h-[88px] shrink-0 flex-col border-r border-border/70 px-2 last:border-r-0', className)}
    >
      <div className="flex h-[72px] items-center gap-1">{children}</div>
      <h2 className="h-4 text-center text-[10px] leading-4 text-muted-foreground">{label}</h2>
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
      className={cn(
        'h-24 min-h-24 shrink-0 [scrollbar-width:thin] overflow-x-auto overflow-y-hidden border-b bg-muted/30 px-1 pt-1',
        className,
      )}
    >
      {activePanel ? (
        <div className="flex min-w-max items-stretch">{activePanel.content}</div>
      ) : (
        <div className="flex h-[88px] items-center text-sm text-muted-foreground">{emptyContent}</div>
      )}
    </section>
  )
}
