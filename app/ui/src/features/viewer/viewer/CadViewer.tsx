import { useCallback, useMemo, useState } from 'react'
import { resolveCadViewerContent, type CadViewerDocument } from './cadViewerContent'
import JscadViewer from './JscadViewer'
import type { CadViewerSource } from './sourceLayers'

export type { CadViewerDocument } from './cadViewerContent'

export type CadViewerProps = {
  experiment: CadViewerDocument | null
  activeExperimentTaskName?: string | null
  onRenderEnd: (sources: readonly CadViewerSource[]) => void
  onRenderError: (message: string, sources: readonly CadViewerSource[]) => void
  onRenderStart: (sources: readonly CadViewerSource[]) => void
}

export function CadViewer({
  activeExperimentTaskName = null,
  experiment,
  onRenderEnd,
  onRenderError,
  onRenderStart,
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
        visibleSources={content.visibleSources}
        onRenderEnd={handleRenderEnd}
        onRenderError={handleRenderError}
        onRenderStart={handleRenderStart}
        onToggleSource={(source) => {
          if (source === 'experiment') setExperimentVisible((current) => !current)
          else setTaskVisible((current) => !current)
        }}
      />
    </section>
  )
}

export default CadViewer
