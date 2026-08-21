import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DefinitionLineageSummary,
  DefinitionPickerDialog,
  HistoryDialog,
  MeasurementPickerDialog,
} from '@/features/cae-workbench/dialogs'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { SavedExperiment, WorkbenchTabId } from '@/features/cae-workbench/types'
import { GeometryExportPublishDialog } from '@/features/cae-workbench/geometry'
import { SaveDefinitionDialog } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { assertExperimentSourceBundle } from '@/lib/cad'
import { AnalysisWorkspace } from '@/pages/analysis/AnalysisPage'
import { MaterialManager } from '@/pages/materials/MaterialManager'
import type { WorkbenchDialog } from './caePageTypes'
import { CaeUtilityDialogs } from './CaeUtilityDialogs'

export function CaeWorkbenchDialogs({
  authenticated,
  dialog,
  guardReplacement,
  openTab,
  runSafely,
  setDialog,
  workbench,
}: {
  authenticated: boolean
  dialog: WorkbenchDialog
  guardReplacement: (run: () => unknown | Promise<unknown>) => void
  openTab: (tab: WorkbenchTabId) => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const closeDialog = (open: boolean) => !open && setDialog(null)
  return (
    <>
      <DefinitionPickerDialog
        authenticated={authenticated}
        open={dialog === 'load-experiment'}
        selectedId={workbench.experimentId}
        onOpenChange={closeDialog}
        onSelect={(row) => guardReplacement(() => workbench.loadExperiment(row as SavedExperiment))}
        onSelectCatalog={(item) =>
          guardReplacement(() => {
            assertExperimentSourceBundle(item.sourceBundle)
            workbench.newExperiment(item.sourceBundle, item.title, item.description)
            openTab('experiment')
          })
        }
      />
      <HistoryDialog
        id={workbench.experimentId}
        open={dialog === 'experiment-history'}
        onOpenChange={closeDialog}
        onSelect={(id) => guardReplacement(() => workbench.loadExperiment(id))}
      />
      <MeasurementPickerDialog
        experimentId={workbench.experimentId}
        open={dialog === 'measurement'}
        selectedId={workbench.selection.measurement?.id}
        onDuplicate={(row) => runSafely(() => workbench.measurementActions.duplicateMeasurement(row))}
        onOpenChange={closeDialog}
        onSelect={(row) => runSafely(() => workbench.selection.loadMeasurement(row))}
      />
      <SaveDefinitionDialog
        context={
          dialog === 'save-experiment' || dialog === 'save-experiment-as' ? (
            <DefinitionLineageSummary id={dialog === 'save-experiment-as' ? null : workbench.experimentId} />
          ) : null
        }
        defaults={{ name: workbench.experimentName, description: workbench.experimentDescription }}
        description={
          dialog === 'save-experiment-as'
            ? '현재 source bundle을 parent가 없는 새 Experiment 계보로 저장합니다.'
            : `현재 source bundle을 저장합니다.${workbench.experimentId ? ` 기준 Experiment #${workbench.experimentId}의 source가 바뀌면 child로 저장됩니다.` : ''}`
        }
        kind="Experiment"
        open={dialog === 'save-experiment' || dialog === 'save-experiment-as'}
        pending={workbench.saving === 'experiment'}
        submitLabel={dialog === 'save-experiment-as' ? '새 계보로 저장' : 'Experiment 저장'}
        title={dialog === 'save-experiment-as' ? 'Save Experiment As' : 'Save Experiment'}
        onOpenChange={closeDialog}
        onSubmit={async (values) => {
          if (workbench.measurementActions.busy) throw new Error('CAE 작업이 끝난 뒤 source를 저장하세요.')
          const forceRoot = dialog === 'save-experiment-as'
          const result = await workbench.saveExperiment(values, forceRoot)
          setDialog(null)
          toast.success(
            forceRoot
              ? 'Experiment를 새 계보로 저장했습니다.'
              : result.action === 'forked'
                ? 'Source 변경을 child Experiment로 저장했습니다.'
                : 'Experiment를 저장했습니다.',
          )
        }}
      />
      <GeometryExportPublishDialog
        geometry={workbench.geometry}
        onOpenChange={closeDialog}
        open={dialog === 'publish-geometry-export'}
      />
      <Dialog open={dialog === 'material'} onOpenChange={closeDialog}>
        <DialogContent className="grid h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle>Material Manager</DialogTitle>
            <DialogDescription>Material 목록과 속성을 조회하고 편집합니다.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto p-4">
            <MaterialManager onRequestLogin={() => setDialog('account')} />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'analysis'} onOpenChange={closeDialog}>
        <DialogContent className="grid h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle>Analyze Measurements</DialogTitle>
            <DialogDescription>현재 Experiment의 Recorded Measurement 데이터를 분석합니다.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto">
            <AnalysisWorkspace
              embedded
              experimentId={workbench.experimentId}
              onRequestLogin={() => setDialog('account')}
            />
          </div>
        </DialogContent>
      </Dialog>
      <CaeUtilityDialogs dialog={dialog} setDialog={setDialog} />
    </>
  )
}
