import { useCallback, useMemo, useState } from 'react'
import { resolveCadViewerContent, type CadViewerDocument } from './cadViewerContent'
import JscadViewer from './JscadViewer'
import type { CadViewerSource } from './sourceLayers'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from './selection'
import type { RayPathBundle } from '@/lib/cad'

export type { CadViewerDocument } from './cadViewerContent'

export type CadViewerProps = {
  experiment: CadViewerDocument | null
  activeExperimentTaskName?: string | null
  onRenderEnd: (sources: readonly CadViewerSource[]) => void
  onRenderError: (message: string, sources: readonly CadViewerSource[]) => void
  onRenderStart: (sources: readonly CadViewerSource[]) => void
  onFindSelectionSource?: (value: string) => void
  onSelectionQueryChange?: (query: CadViewerSelectionQuery | null) => void
  onSelectionSourcePathsChange?: (values: readonly string[]) => void
  onToggleViewerExpanded?: () => void
  rayPaths?: readonly RayPathBundle[]
  selectionQuery?: CadViewerSelectionQuery | null
  selectionSourceStatus?: Readonly<Record<string, CadViewerSourceLookupStatus>>
  viewerExpanded?: boolean
}

export function CadViewer({
  activeExperimentTaskName = null,
  experiment,
  onRenderEnd,
  onRenderError,
  onRenderStart,
  onFindSelectionSource,
  onSelectionQueryChange,
  onSelectionSourcePathsChange,
  onToggleViewerExpanded,
  rayPaths,
  selectionQuery,
  selectionSourceStatus,
  viewerExpanded,
}: CadViewerProps) {
  const [experimentVisible, setExperimentVisible] = useState(true)
  const [taskVisible, setTaskVisible] = useState(true)
  const content = useMemo(
    () => resolveCadViewerContent(experiment, experimentVisible, taskVisible, activeExperimentTaskName),
    [activeExperimentTaskName, experiment, experimentVisible, taskVisible],
  )
  const handleRenderStart = useCallback(
    () => onRenderStart(content.visibleSources),
    [content.visibleSources, onRenderStart],
  )
  const handleRenderEnd = useCallback(() => onRenderEnd(content.visibleSources), [content.visibleSources, onRenderEnd])
  const handleRenderError = useCallback(
    (message: string) => onRenderError(message, content.visibleSources),
    [content.visibleSources, onRenderError],
  )

  return (
    <section aria-label="3D CAD Viewer" className="h-full min-h-[360px] min-w-0 lg:min-h-0 lg:overflow-hidden">
      <JscadViewer
        availableSources={content.availableSources}
        emptyMessage={content.emptyMessage}
        layers={content.layers}
        lengthUnit={content.lengthUnit}
        onFindSelectionSource={onFindSelectionSource}
        onSelectionQueryChange={onSelectionQueryChange}
        onSelectionSourcePathsChange={onSelectionSourcePathsChange}
        rayPaths={rayPaths}
        selectionQuery={selectionQuery}
        selectionSourceStatus={selectionSourceStatus}
        visibleSources={content.visibleSources}
        onRenderEnd={handleRenderEnd}
        onRenderError={handleRenderError}
        onRenderStart={handleRenderStart}
        onToggleViewerExpanded={onToggleViewerExpanded}
        viewerExpanded={viewerExpanded}
        onToggleSource={(source) => {
          if (source === 'experiment') setExperimentVisible((current) => !current)
          else setTaskVisible((current) => !current)
        }}
      />
    </section>
  )
}

export default CadViewer
