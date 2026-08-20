import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { WorkbenchAction } from '@/features/cae-workbench/chrome'

export function RibbonActions({
  actions,
  children,
  extraActions,
}: {
  actions: readonly WorkbenchAction[]
  children?: ReactNode
  extraActions?: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-stretch gap-3">
      {children ? <div className="flex min-w-48 flex-col justify-center border-r pr-3">{children}</div> : null}
      <div className="flex items-center gap-1">
        {actions.map((action) => (
          <Button
            aria-label={
              action.disabled && action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label
            }
            disabled={action.disabled}
            key={action.id}
            size="sm"
            title={action.disabledReason}
            type="button"
            variant="ghost"
            onClick={action.onSelect}
          >
            {action.icon}
            {action.label}
          </Button>
        ))}
      </div>
      {extraActions}
    </div>
  )
}
