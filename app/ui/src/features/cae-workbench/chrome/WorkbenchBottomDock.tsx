import { ChevronDown, ChevronUp, Terminal } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { BottomDockMode } from '../types'

export function WorkbenchBottomDock({
  mode,
  onModeChange,
  console: consoleContent,
  summary,
  className,
}: {
  mode: BottomDockMode
  onModeChange: (mode: BottomDockMode) => void
  console: ReactNode
  summary: ReactNode
  className?: string
}) {
  const id = useId()
  const consolePanelId = `${id}-console-panel`

  return (
    <section aria-label="Workbench Console" className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <button
        aria-controls={consolePanelId}
        aria-expanded={mode === 'console'}
        className="flex h-7 w-full min-w-0 items-center gap-2 border-t border-slate-200 bg-slate-50 px-2 font-mono text-xs text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-inset"
        id={`${id}-console-toggle`}
        onClick={() => onModeChange(mode === 'console' ? 'hidden' : 'console')}
        type="button"
      >
        <Terminal aria-hidden="true" className="size-3.5 shrink-0 text-slate-500" />
        <span className="shrink-0 font-sans font-medium">Console</span>
        {mode === 'hidden' ? summary : <span className="min-w-0 flex-1" />}
        {mode === 'console' ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
        ) : (
          <ChevronUp aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
        )}
      </button>
      <div className={cn('min-h-0 flex-1 overflow-hidden', mode === 'hidden' && 'hidden')}>
        <div
          aria-labelledby={`${id}-console-toggle`}
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
