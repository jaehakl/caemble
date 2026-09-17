import { useSyncExternalStore } from 'react'
import { ViewerToolbar } from './ViewerToolbar'
import type { createComparisonCamera } from './comparisonCamera'
import type { CadViewerSource } from './sourceLayers'

export function ComparisonToolbar({ camera }: { camera: ReturnType<typeof createComparisonCamera> }) {
  const renderers = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot)
  if (!renderers.length) return null
  const toolbars = renderers.map((renderer) => renderer.toolbar)
  const primary = toolbars[0]
  const sources = (['experiment', 'task'] as const).filter((source) =>
    toolbars.some((toolbar) => toolbar.availableSources?.includes(source)),
  )
  const expanded = toolbars.find((toolbar) => toolbar.onToggleViewerExpanded)
  return (
    <div data-capture-exclude>
      <ViewerToolbar
        {...primary}
        meshMode={toolbars.every((toolbar) => toolbar.meshMode)}
        availableSources={sources}
        visibleSources={sources.filter((source) =>
          toolbars.some((toolbar) => toolbar.visibleSources?.includes(source)),
        )}
        onToggleSource={
          toolbars.some((toolbar) => toolbar.onToggleSource)
            ? (source: CadViewerSource) => {
                toolbars
                  .find((toolbar) => toolbar.availableSources?.includes(source) && toolbar.onToggleSource)
                  ?.onToggleSource?.(source)
              }
            : undefined
        }
        onToggleViewerExpanded={expanded?.onToggleViewerExpanded}
        viewerExpanded={expanded?.viewerExpanded}
      />
    </div>
  )
}
