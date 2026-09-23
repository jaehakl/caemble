import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Box } from 'lucide-react'
import type { GeometryMode } from './viewerDisplay'

export const GeometryDisplayManaged = createContext(false)
export const ViewerControlTarget = createContext<{ host: HTMLElement | null } | null>(null)

export function GeometryDisplayButton({
  mode,
  onChange,
}: {
  mode: GeometryMode
  onChange: (mode: GeometryMode) => void
}) {
  return (
    <ViewerToolButton
      label={`Geometry · ${mode ? `${mode * 100}%` : 'off'}`}
      active={mode > 0}
      onClick={() => onChange(mode === 0.9 ? 0.5 : 0.9)}
    >
      <Box />
    </ViewerToolButton>
  )
}

export type ViewerControlPlacement = 'presentation' | 'camera' | 'data' | 'side'
export const ViewerToolHosts = createContext<Partial<Record<ViewerControlPlacement, HTMLDivElement | null>> | null>(
  null,
)
export const ViewerPanelHost = createContext<HTMLDivElement | null>(null)

/** The outermost viewer owns the toolbar hosts, including both panes of a comparison. */
export function ViewerLayout({ children }: { children: ReactNode }) {
  const parent = useContext(ViewerToolHosts)
  const [presentation, setPresentation] = useState<HTMLDivElement | null>(null)
  const [camera, setCamera] = useState<HTMLDivElement | null>(null)
  const [data, setData] = useState<HTMLDivElement | null>(null)
  const [side, setSide] = useState<HTMLDivElement | null>(null)
  const [panels, setPanels] = useState<HTMLDivElement | null>(null)
  if (parent) return children
  return (
    <ViewerToolHosts.Provider value={{ presentation, camera, data, side }}>
      <ViewerPanelHost.Provider value={panels}>
        <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white" data-viewer-layout>
          <div
            aria-label="Viewer 공통 툴바"
            role="toolbar"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-1 empty:hidden"
            data-capture-exclude
          >
            <div ref={setPresentation} className="flex shrink-0 items-center gap-1 empty:hidden" />
            <div ref={setCamera} className="flex shrink-0 items-center gap-1 empty:hidden" />
            <div ref={setData} className="flex shrink-0 items-center gap-1 empty:hidden" />
          </div>
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <div
              ref={setSide}
              role="toolbar"
              aria-label="데이터 도구모음"
              aria-orientation="vertical"
              data-capture-exclude
              className="flex w-11 shrink-0 flex-col gap-1 overflow-x-hidden overflow-y-auto border-r p-1 text-xs empty:hidden"
            />
            <div className="min-h-0 min-w-0 flex-1">{children}</div>
            <div
              ref={setPanels}
              data-capture-exclude
              aria-label="Viewer 설정 패널"
              className="pointer-events-none absolute inset-y-0 left-12 z-20 flex w-64 max-w-[calc(100%-3.25rem)] flex-col overflow-x-hidden overflow-y-auto p-1"
            />
          </div>
        </div>
      </ViewerPanelHost.Provider>
    </ViewerToolHosts.Provider>
  )
}

export function ViewerToolButton({
  label,
  active,
  children,
  className,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
}) {
  return (
    <span className="inline-flex size-8 shrink-0" title={title ?? label}>
      <button
        {...props}
        type="button"
        aria-label={props['aria-label'] ?? label}
        aria-pressed={active}
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded border p-0 text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4',
          active ? 'border-sky-500 bg-sky-50 text-sky-900' : 'border-slate-300 bg-white',
          className,
        )}
      >
        {children}
      </button>
    </span>
  )
}

export function ViewerToolPanel({
  label,
  icon,
  children,
  active,
  onClose,
  initialOpen = false,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
  active?: boolean
  onClose?: () => void
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div className="flex items-start gap-1">
      <ViewerToolButton
        label={label}
        active={active ?? open}
        aria-expanded={open}
        onClick={() => {
          if (open) onClose?.()
          setOpen(!open)
        }}
      >
        {icon}
      </ViewerToolButton>
      {open ? (
        <ViewerToolPanelBody
          label={label}
          onClose={() => {
            setOpen(false)
            onClose?.()
          }}
        >
          {children}
        </ViewerToolPanelBody>
      ) : null}
    </div>
  )
}

export function ViewerToolPanelBody({
  label,
  children,
  onClose,
}: {
  label: string
  children: ReactNode
  onClose: () => void
}) {
  const host = useContext(ViewerPanelHost)
  const anchorId = useId()
  const panelRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (!host || !panelRef.current) return
    const arrange = () => arrangeViewerPanels(host)
    arrange()
    panelRef.current.scrollIntoView?.({ block: 'nearest' })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(arrange)
    observer?.observe(host)
    observer?.observe(panelRef.current)
    window.addEventListener('resize', arrange)
    const rail = host.parentElement?.querySelector('[aria-orientation="vertical"]')
    rail?.addEventListener('scroll', arrange)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', arrange)
      rail?.removeEventListener('scroll', arrange)
      queueMicrotask(arrange)
    }
  }, [host])
  const panel = (
    <section
      ref={panelRef}
      data-viewer-floating-panel={anchorId}
      aria-label={`${label} 패널`}
      className="pointer-events-auto grid w-full min-w-0 shrink-0 gap-2 rounded border bg-white/95 p-2 text-xs shadow-md [&_input[type=number]]:min-w-0 [&_input[type=number]]:rounded [&_input[type=number]]:border [&_input[type=number]]:p-1 [&_select]:max-w-full [&_select]:rounded [&_select]:border [&_select]:bg-white [&_select]:p-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      {children}
    </section>
  )
  return (
    <>
      <span id={anchorId} hidden />
      {host ? createPortal(panel, host) : panel}
    </>
  )
}

/** Stack adjacent popovers without changing the width of the canvas or the icon rail. */
function arrangeViewerPanels(host: HTMLElement) {
  const top = host.getBoundingClientRect().top
  const entries = Array.from(host.querySelectorAll<HTMLElement>('[data-viewer-floating-panel]'))
    .map((panel) => ({
      panel,
      top:
        document.getElementById(panel.dataset.viewerFloatingPanel!)?.parentElement?.getBoundingClientRect().top ?? top,
    }))
    .sort((a, b) => a.top - b.top)
  let bottom = 0
  entries.forEach(({ panel, top: anchorTop }, order) => {
    const gap = Math.max(order ? 4 : 0, anchorTop - top - bottom)
    panel.style.order = String(order)
    panel.style.marginTop = `${gap}px`
    bottom += gap + panel.offsetHeight
  })
}

/** Axis identity remains visible while its border communicates the current role. */
export function ViewerAxisIcon({ axis }: { axis: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 19h17M3 19V3M3 19l8-8" />
      <text x="12" y="10" fill="currentColor" stroke="none" fontSize={axis.length > 1 ? 7 : 11} fontWeight="600">
        {axis}
      </text>
    </svg>
  )
}

export function ViewerToolMenu({
  label,
  icon,
  children,
  modal = true,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
  modal?: boolean
}) {
  const [boundary, setBoundary] = useState<HTMLElement | null>(null)
  return (
    <DropdownMenu modal={modal}>
      <DropdownMenuTrigger asChild>
        <ViewerToolButton
          label={label}
          onFocus={(event) => setBoundary(event.currentTarget.closest<HTMLElement>('[data-viewer-layout]'))}
        >
          {icon}
        </ViewerToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        collisionBoundary={boundary}
        collisionPadding={4}
        align="start"
        data-capture-exclude
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-auto"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A native select over the icon opens its options in one gesture and closes on selection. */
export function ViewerSelectTool({
  label,
  icon,
  className,
  title,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; icon: ReactNode }) {
  return (
    <span
      title={title ?? label}
      className={cn(
        'relative flex size-8 shrink-0 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 focus-within:outline-2 focus-within:outline-sky-600 hover:bg-slate-100 [&_svg]:size-4',
        props.disabled && 'opacity-40',
        className,
      )}
    >
      {icon}
      <select
        {...props}
        aria-label={props['aria-label'] ?? label}
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      >
        {children}
      </select>
    </span>
  )
}
