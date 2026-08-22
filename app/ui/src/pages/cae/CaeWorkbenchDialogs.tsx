import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { SaveDefinitionDialog } from '@/features/viewer/persistence/SaveDefinitionDialog'
import type { WorkbenchDialog } from './caePageTypes'
import { CaeUtilityDialogs } from './CaeUtilityDialogs'

export function CaeWorkbenchDialogs({
  dialog,
  setDialog,
  workbench,
}: {
  dialog: WorkbenchDialog
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const closeDialog = (open: boolean) => !open && setDialog(null)
  return (
    <>
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
      <CaeUtilityDialogs dialog={dialog} setDialog={setDialog} />
    </>
  )
}
