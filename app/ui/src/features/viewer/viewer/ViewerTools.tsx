import { createContext, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Box } from 'lucide-react'
import type { GeometryMode } from './viewerDisplay'
import { ViewerPlaybackProvider } from './viewerPlaybackState'

export const GeometryDisplayManaged = createContext(false)

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

export type ViewerControlPlacement = 'presentation' | 'camera' | 'data' | 'actions'
export const ViewerToolHosts = createContext<Partial<Record<ViewerControlPlacement, HTMLDivElement | null>> | null>(
  null,
)
export const ViewerOutputMenuHost = createContext<{
  host: HTMLDivElement | null
  setHost: (host: HTMLDivElement | null) => void
} | null>(null)

/** The outermost viewer owns the toolbar hosts, including both panes of a comparison. */
export function ViewerLayout({ children }: { children: ReactNode }) {
  const parent = useContext(ViewerToolHosts)
  const [presentation, setPresentation] = useState<HTMLDivElement | null>(null)
  const [camera, setCamera] = useState<HTMLDivElement | null>(null)
  const [data, setData] = useState<HTMLDivElement | null>(null)
  const [actions, setActions] = useState<HTMLDivElement | null>(null)
  const [outputMenu, setOutputMenu] = useState<HTMLDivElement | null>(null)
  if (parent) return children
  return (
    <ViewerToolHosts.Provider value={{ presentation, camera, data, actions }}>
      <ViewerPlaybackProvider>
        <ViewerOutputMenuHost.Provider value={{ host: outputMenu, setHost: setOutputMenu }}>
          <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white" data-viewer-layout>
            <div
              aria-label="Viewer 공통 툴바"
              role="toolbar"
              className="flex shrink-0 items-center gap-1 overflow-hidden border-b p-1 empty:hidden"
              data-capture-exclude
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <div ref={setPresentation} className="flex shrink-0 items-center gap-1 empty:hidden" />
                <div ref={setCamera} className="flex shrink-0 items-center gap-1 empty:hidden" />
                <div ref={setData} className="flex shrink-0 items-center gap-1 empty:hidden" />
              </div>
              <div ref={setActions} className="ml-auto flex shrink-0 items-center gap-1 empty:hidden" />
            </div>
            <div className="relative flex min-h-0 min-w-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1">{children}</div>
            </div>
          </div>
        </ViewerOutputMenuHost.Provider>
      </ViewerPlaybackProvider>
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
