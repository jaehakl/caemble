import { useCallback, useMemo, useState } from 'react'
import type { CadDocumentType } from '@/lib/cad'
import { resolveCadViewerContent, type CadViewerDocument } from './cadViewerContent'
import JscadViewer from './JscadViewer'

export type { CadViewerDocument } from './cadViewerContent'

export type CadViewerProps = {
  structure: CadViewerDocument | null
  experiment: CadViewerDocument | null
  activeExperimentTaskName?: string | null
  onRenderEnd: (sources: readonly CadDocumentType[]) => void
  onRenderError: (message: string, sources: readonly CadDocumentType[]) => void
  onRenderStart: (sources: readonly CadDocumentType[]) => void
}

export function CadViewer({
  activeExperimentTaskName = null,
  experiment,
  onRenderEnd,
  onRenderError,
  onRenderStart,
  structure,
}: CadViewerProps) {
  const [structureVisible, setStructureVisible] = useState(true)
  const [experimentVisible, setExperimentVisible] = useState(true)
  const content = useMemo(
    () => resolveCadViewerContent(structure, experiment, structureVisible, experimentVisible, activeExperimentTaskName),
    [activeExperimentTaskName, experiment, experimentVisible, structure, structureVisible],
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
        onToggleSource={(documentType) => {
          if (documentType === 'structure') setStructureVisible((current) => !current)
          else setExperimentVisible((current) => !current)
        }}
      />
    </section>
  )
}

export default CadViewer
