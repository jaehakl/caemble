import { useCallback, useMemo, useState } from 'react'
import type { CadDocumentType, RecordedDataResult, RecordedDataRule } from '@/lib/cad'
import { resolveCadViewerContent, type CadViewerDocument } from './cadViewerContent'
import JscadViewer from './JscadViewer'
import type { CadViewerRecordedData } from './recordedData'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import type { SimulationProcess } from '../workspace/simulationUiTypes'

export type { CadViewerDocument } from './cadViewerContent'
export type { CadViewerRecordedAxis, CadViewerRecordedData, CadViewerRecordedTensor } from './recordedData'

export type CadViewerProps = {
  structure: CadViewerDocument | null
  experiment: CadViewerDocument | null
  activeExperimentTaskName?: string | null
  recordedData?: CadViewerRecordedData | null
  resultsLayout?: 'split' | 'tabs'
  simulation?: CadViewerSimulation | null
  onRenderEnd: (sources: readonly CadDocumentType[]) => void
  onRenderError: (message: string, sources: readonly CadDocumentType[]) => void
  onRenderStart: (sources: readonly CadDocumentType[]) => void
}

export type CadViewerSimulation = Readonly<{
  canRun: boolean
  cancel: () => void
  process: SimulationProcess
  program?: SimulationProgramManifest | null
  run: () => string | null
  stale: boolean
}>

export function CadViewer({
  activeExperimentTaskName = null,
  experiment,
  onRenderEnd,
  onRenderError,
  onRenderStart,
  recordedData,
  resultsLayout,
  simulation,
  structure,
}: CadViewerProps) {
  const [structureVisible, setStructureVisible] = useState(true)
  const [experimentVisible, setExperimentVisible] = useState(true)
  const content = useMemo(
    () => resolveCadViewerContent(structure, experiment, structureVisible, experimentVisible, activeExperimentTaskName),
    [activeExperimentTaskName, experiment, experimentVisible, structure, structureVisible],
  )
  const programRecordedDataRules = useMemo<readonly RecordedDataRule[]>(
    () =>
      Object.freeze(
        Object.entries(simulation?.program?.recordedData ?? {}).map(([name, result]) =>
          Object.freeze({
            target: Object.freeze([]),
            label: name,
            methodId: 'simulation.record',
            parameters: Object.freeze({}),
            result: result as RecordedDataResult,
          }),
        ),
      ),
    [simulation?.program],
  )
  const recordedDataRules = programRecordedDataRules
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
        recordedData={recordedData}
        recordedDataRules={recordedDataRules}
        resultsLayout={resultsLayout}
        simulation={simulation}
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
