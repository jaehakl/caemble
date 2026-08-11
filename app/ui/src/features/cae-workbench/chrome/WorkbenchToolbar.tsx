import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorkbenchAction } from './actions'

export function WorkbenchToolbar({
  actions,
  ariaLabel = 'CAE 빠른 작업',
  className,
}: {
  actions: readonly WorkbenchAction[]
  ariaLabel?: string
  className?: string
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <div
        aria-label={ariaLabel}
        className={cn('flex min-h-10 items-center gap-1 overflow-x-auto border-b bg-muted/25 px-2 py-1', className)}
        role="toolbar"
      >
        {actions.map((action) => {
          const disabledMessage = action.disabled ? action.disabledReason || '현재 이 작업을 사용할 수 없습니다.' : null
          const tooltip = disabledMessage ? `${action.label} — ${disabledMessage}` : action.label
          return (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <Button
                  aria-disabled={action.disabled || undefined}
                  aria-label={disabledMessage ? `${action.label}: ${disabledMessage}` : action.label}
                  className="size-8 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                  onClick={() => {
                    if (!action.disabled) action.onSelect()
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  {action.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tooltip}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
