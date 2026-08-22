import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import type { WorkbenchSectionId } from '../types'
import { defaultWorkbenchSections, type WorkbenchSectionDefinition } from './actions'

export function WorkbenchMenubar({
  activeSectionId,
  onActiveSectionChange,
  sections = defaultWorkbenchSections,
  ariaLabel = 'CAE 워크벤치 메뉴',
  className,
}: {
  activeSectionId: WorkbenchSectionId
  onActiveSectionChange: (sectionId: WorkbenchSectionId) => void
  sections?: readonly WorkbenchSectionDefinition[]
  ariaLabel?: string
  className?: string
}) {
  const buttonRefs = useRef(new Map<WorkbenchSectionId, HTMLButtonElement>())

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, sectionId: WorkbenchSectionId) => {
    const enabled = sections.filter((section) => !section.disabled)
    const currentIndex = enabled.findIndex((section) => section.id === sectionId)
    if (currentIndex < 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabled.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabled.length) % enabled.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = enabled.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = enabled[nextIndex]
    if (!next) return
    onActiveSectionChange(next.id)
    buttonRefs.current.get(next.id)?.focus()
  }

  return (
    <div
      aria-label={ariaLabel}
      className={cn('flex h-9 items-center gap-0.5 overflow-x-auto border-b bg-background px-1', className)}
      role="menubar"
    >
      {sections.map((section) => {
        const active = section.id === activeSectionId
        const accessibleLabel =
          section.disabled && section.disabledReason ? `${section.label}: ${section.disabledReason}` : section.label
        return (
          <button
            aria-checked={active}
            aria-label={accessibleLabel}
            className={cn(
              'relative flex h-8 shrink-0 items-center rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-45',
              active &&
                'bg-accent text-accent-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary',
            )}
            disabled={section.disabled}
            key={section.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(section.id, node)
              else buttonRefs.current.delete(section.id)
            }}
            role="menuitemradio"
            tabIndex={active ? 0 : -1}
            title={section.disabledReason}
            type="button"
            onClick={() => onActiveSectionChange(section.id)}
            onKeyDown={(event) => moveFocus(event, section.id)}
          >
            {section.label}
          </button>
        )
      })}
    </div>
  )
}
