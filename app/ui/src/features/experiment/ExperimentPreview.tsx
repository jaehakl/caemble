import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'

export function ExperimentPreview({ workbench }: { workbench: CaeWorkbenchState }) {
  if (!workbench.experimentId)
    return <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">Experiment를 선택하세요.</p>
  return (
    <WorkbenchViewer
      key={`${workbench.experimentId}:${workbench.experimentDocument.resultSessionKey ?? ''}`}
      experiment={workbench.experiment}
      experimentDocument={workbench.experimentDocument}
      onFindSelectionSource={() => {}}
      onSelectionQueryChange={() => {}}
      onSelectionSourcePathsChange={() => {}}
      onToggleViewerExpanded={() => {}}
      viewerExpanded={false}
      selectionQuery={null}
      selectionSourceStatus={{}}
      autoSelectResult={Boolean(workbench.selection.measurement)}
      resultContracts={workbench.selection.resultContracts}
      visualizations={workbench.selection.visualizations}
      resultErrors={workbench.selection.resultErrors}
      resultSourceHash={workbench.selection.materialSnapshot?.sourceHash}
      resultVarsHash={workbench.selection.materialSnapshot?.varsHash}
      recordedData={workbench.selection.flatRecordedData}
      recordedRules={workbench.selection.recordedRules}
      loading={workbench.selection.loading || workbench.selectionRestoring}
      downloadProgress={workbench.selection.downloadProgress}
    />
  )
}
