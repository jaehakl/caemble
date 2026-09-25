import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ResizableWorkbenchSplit } from './ResizableWorkbenchSplit'

export function ExperimentWorkspace({
  menubar,
  ribbon,
  viewer,
  editor,
  vars,
  measurements,
  varsLayout,
  onVarsLayoutChange,
}: {
  menubar: ReactNode
  ribbon: ReactNode
  viewer: ReactNode
  editor: ReactNode
  vars?: ReactNode
  measurements?: (active: boolean) => ReactNode
  varsLayout?: { width: number; collapsed: boolean }
  onVarsLayoutChange?: (layout: { width: number; collapsed: boolean }) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(1200)
  const [tab, setTab] = useState('vars')
  const [localLayout, setLocalLayout] = useState({ width: 280, collapsed: false })
  const layout = varsLayout ?? localLayout
  const updateLayout = onVarsLayoutChange ?? setLocalLayout
  const maximum = Math.min(480, availableWidth * 0.4)
  const minimum = Math.min(200, maximum)
  const width = Math.max(minimum, Math.min(maximum, layout.width))
  const hasVars = vars !== undefined
  useLayoutEffect(() => {
    const element = container.current
    if (!element || !hasVars) return
    const observer = new ResizeObserver(() => {
      const measured = element.getBoundingClientRect().width
      if (measured > 0) setAvailableWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasVars])
  return (
    <div className="flex h-full min-h-0 flex-col">
      {menubar}
      {ribbon}
      <div className="flex min-h-0 flex-1" ref={container}>
        {vars !== undefined ? (
          <>
            <aside
              aria-label="Vars"
              className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r"
              style={{ width: layout.collapsed ? 36 : width }}
            >
              <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-9 shrink-0 items-center justify-between border-b px-1">
                  {!layout.collapsed ? (
                    measurements ? (
                      <TabsList aria-label="Experiment 데이터" className="h-8 min-w-0 bg-transparent p-0">
                        <TabsTrigger value="vars" className="px-2 text-xs">
                          Vars
                        </TabsTrigger>
                        <TabsTrigger value="measurements" className="px-2 text-xs">
                          Measurements
                        </TabsTrigger>
                      </TabsList>
                    ) : (
                      <span className="px-2 text-xs font-semibold">Vars</span>
                    )
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={layout.collapsed ? 'Vars 펼치기' : 'Vars 접기'}
                    onClick={() => updateLayout({ ...layout, collapsed: !layout.collapsed })}
                  >
                    {layout.collapsed ? <ChevronRight /> : <ChevronLeft />}
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto" hidden={layout.collapsed}>
                  <TabsContent value="vars" forceMount hidden={tab !== 'vars'} className="m-0">
                    {vars}
                  </TabsContent>
                  {measurements ? (
                    <TabsContent value="measurements" forceMount hidden={tab !== 'measurements'} className="m-0 h-full">
                      {measurements(tab === 'measurements' && !layout.collapsed)}
                    </TabsContent>
                  ) : null}
                </div>
              </Tabs>
            </aside>
            <div
              role="separator"
              aria-label="Vars 너비 조절"
              aria-orientation="vertical"
              aria-valuemin={minimum}
              aria-valuemax={maximum}
              aria-valuenow={width}
              tabIndex={layout.collapsed ? -1 : 0}
              hidden={layout.collapsed}
              className="w-1.5 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(event) => {
                if (event.button === 0) {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return
                updateLayout({
                  ...layout,
                  width: Math.max(
                    minimum,
                    Math.min(maximum, event.clientX - container.current.getBoundingClientRect().left),
                  ),
                })
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onKeyDown={(event) => {
                let next: number
                if (event.key === 'Home') next = minimum
                else if (event.key === 'End') next = maximum
                else if (event.key === 'ArrowLeft') next = Math.max(minimum, width - 20)
                else if (event.key === 'ArrowRight') next = Math.min(maximum, width + 20)
                else return
                event.preventDefault()
                updateLayout({ ...layout, width: next })
              }}
            />
          </>
        ) : null}
        <ResizableWorkbenchSplit viewer={viewer} editor={editor} />
      </div>
    </div>
  )
}
