import type { ReactNode } from 'react'
import { ResizableWorkbenchSplit } from './ResizableWorkbenchSplit'

export function ExperimentWorkspace({
  menubar,
  ribbon,
  viewer,
  editor,
  expanded,
}: {
  menubar: ReactNode
  ribbon: ReactNode
  viewer: ReactNode
  editor: ReactNode
  expanded: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {menubar}
      {ribbon}
      <div className="flex min-h-0 flex-1">
        <ResizableWorkbenchSplit viewer={viewer} editor={editor} viewerExpanded={expanded} />
      </div>
    </div>
  )
}
