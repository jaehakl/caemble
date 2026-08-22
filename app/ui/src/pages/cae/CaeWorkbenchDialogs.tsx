import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MeasurementPickerDialog } from '@/features/cae-workbench/dialogs'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { SaveDefinitionDialog } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { AnalysisWorkspace } from '@/pages/analysis/AnalysisPage'
import { MaterialManager } from '@/pages/materials/MaterialManager'
import type { WorkbenchDialog } from './caePageTypes'
import { CaeUtilityDialogs } from './CaeUtilityDialogs'

export function CaeWorkbenchDialogs({
  dialog,
  runSafely,
  setDialog,
  workbench,
}: {
  dialog: WorkbenchDialog
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const closeDialog = (open: boolean) => !open && setDialog(null)
  return (
    <>
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
          dialog === 'save-experiment' || dialog === 'save-experiment-version' || dialog === 'save-experiment-as' ? (
            <p className="rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {dialog === 'save-experiment-as' || !workbench.experimentRecord
                ? '새 coordinate · initial version 0.1.0'
                : workbench.experimentCoordinate}
            </p>
          ) : null
        }
        defaults={{
          name: workbench.experimentName,
          description: workbench.experimentDescription,
          repository: workbench.experimentRecord?.repository_slug ?? 'experiments',
          key:
            workbench.experimentRecord?.experiment_key ??
            (workbench.experimentName
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/gu, '-')
              .replace(/^-+|-+$/gu, '') ||
              'untitled-experiment'),
          bump: 'patch',
        }}
        description={
          dialog === 'save-experiment-as'
            ? '현재 source bundle을 새 namespace / repository / key의 Experiment로 저장합니다.'
            : dialog === 'save-experiment-version'
              ? '현재 Version을 기준으로 새 SemVer Version을 저장합니다.'
              : workbench.experimentRecord
                ? '현재 Version의 source와 메타데이터를 덮어씁니다.'
                : '현재 source bundle을 첫 Experiment Version으로 저장합니다.'
        }
        mode={
          dialog === 'save-experiment-version'
            ? 'new_version'
            : dialog === 'save-experiment-as' || !workbench.experimentRecord
              ? 'create'
              : 'overwrite'
        }
        open={dialog === 'save-experiment' || dialog === 'save-experiment-version' || dialog === 'save-experiment-as'}
        pending={workbench.saving === 'experiment'}
        submitLabel={
          dialog === 'save-experiment-version'
            ? '새 Version 저장'
            : dialog === 'save-experiment-as'
              ? '새 Experiment 저장'
              : 'Experiment 저장'
        }
        title={
          dialog === 'save-experiment-version'
            ? 'Save New Version'
            : dialog === 'save-experiment-as'
              ? 'Save Experiment As'
              : 'Save Experiment'
        }
        onOpenChange={closeDialog}
        onSubmit={async (values) => {
          if (workbench.measurementActions.busy) throw new Error('CAE 작업이 끝난 뒤 source를 저장하세요.')
          const mode =
            dialog === 'save-experiment-version'
              ? 'new_version'
              : dialog === 'save-experiment-as' || !workbench.experimentRecord
                ? 'create'
                : 'overwrite'
          const result = await workbench.saveExperiment(values, mode)
          setDialog(null)
          toast.success(
            result.action === 'new_version'
              ? `Experiment ${result.version}을 저장했습니다.`
              : result.action === 'create'
                ? '새 Experiment를 저장했습니다.'
                : 'Experiment Version을 저장했습니다.',
          )
        }}
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
