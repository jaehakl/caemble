import { Box } from 'lucide-react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ResizableWorkbenchSplit } from './ResizableWorkbenchSplit'

const desktopQuery = '(min-width: 1024px)'

function subscribeToDesktopQuery(callback: () => void) {
  const mediaQuery = window.matchMedia(desktopQuery)
  mediaQuery.addEventListener('change', callback)
  return () => mediaQuery.removeEventListener('change', callback)
}

function desktopSnapshot() {
  return window.matchMedia(desktopQuery).matches
}

export function WorkbenchShell({
  menubar,
  toolbar,
  ribbon,
  viewer,
  editor,
  viewerPercent,
  defaultViewerPercent,
  onViewerPercentChange,
  mobileViewerOpen,
  onMobileViewerOpenChange,
  className,
}: {
  menubar: ReactNode
  toolbar: ReactNode
  ribbon: ReactNode
  viewer: ReactNode
  editor: ReactNode
  viewerPercent?: number
  defaultViewerPercent?: number
  onViewerPercentChange?: (viewerPercent: number) => void
  mobileViewerOpen?: boolean
  onMobileViewerOpenChange?: (open: boolean) => void
  className?: string
}) {
  const desktop = useSyncExternalStore(subscribeToDesktopQuery, desktopSnapshot, () => true)
  const [internalViewerOpen, setInternalViewerOpen] = useState(false)
  const viewerOpen = mobileViewerOpen ?? internalViewerOpen
  const setViewerOpen = (open: boolean) => {
    if (mobileViewerOpen === undefined) setInternalViewerOpen(open)
    onMobileViewerOpenChange?.(open)
  }

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background', className)}>
      <div className="shrink-0">
        {menubar}
        {toolbar}
        {ribbon}
      </div>
      {desktop ? (
        <ResizableWorkbenchSplit
          defaultViewerPercent={defaultViewerPercent}
          editor={editor}
          onViewerPercentChange={onViewerPercentChange}
          viewer={viewer}
          viewerPercent={viewerPercent}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 justify-end border-b bg-muted/20 px-2 py-1">
            <Button onClick={() => setViewerOpen(true)} size="sm" type="button" variant="outline">
              <Box aria-hidden="true" />
              3D Viewer
            </Button>
          </div>
          <section aria-label="Editor" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {editor}
          </section>
          <Dialog onOpenChange={setViewerOpen} open={viewerOpen}>
            <DialogContent className="h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
              <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
                <DialogTitle>3D Viewer</DialogTitle>
                <DialogDescription className="sr-only">
                  현재 Structure와 Experiment 형상을 표시합니다.
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 overflow-hidden">{viewer}</div>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  )
}
