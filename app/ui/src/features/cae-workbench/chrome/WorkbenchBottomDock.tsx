import { PanelBottomClose, Terminal } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { BottomDockMode } from '../types'

export function WorkbenchBottomDock({
  mode,
  onModeChange,
  console: consoleContent,
  className,
}: {
  mode: BottomDockMode
  onModeChange: (mode: BottomDockMode) => void
  console: ReactNode
  className?: string
}) {
  const id = useId()
  const consolePanelId = `${id}-console-panel`

  return (
    <section aria-label="중앙 하단 도크" className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <div className="flex h-8 shrink-0 items-center border-t bg-muted/30 px-1">
        <div aria-label="하단 도크 보기" className="flex h-full items-center" role="tablist">
          <button
            aria-controls={consolePanelId}
            aria-selected={mode === 'console'}
            className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
            data-selected={mode === 'console'}
            id={`${id}-console-tab`}
            onClick={() => onModeChange('console')}
            role="tab"
            tabIndex={0}
            type="button"
          >
            <Terminal aria-hidden="true" className="size-3.5" />
            Console
          </button>
        </div>
        <button
          aria-label="하단 도크 숨기기"
          className="ml-auto flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          disabled={mode === 'hidden'}
          onClick={() => onModeChange('hidden')}
          title="숨기기"
          type="button"
        >
          <PanelBottomClose aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-hidden', mode === 'hidden' && 'hidden')}>
        <div
          aria-labelledby={`${id}-console-tab`}
          className="h-full min-h-0"
          hidden={mode !== 'console'}
          id={consolePanelId}
          role="tabpanel"
        >
          {consoleContent}
        </div>
      </div>
    </section>
  )
}
