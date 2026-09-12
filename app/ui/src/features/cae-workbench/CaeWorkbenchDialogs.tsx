import type { Dispatch, SetStateAction } from 'react'
import type { UserData } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { SaveExperimentDialog } from '@/features/experiment/SaveExperimentDialog'
import { LoadExperimentDialog } from '@/features/experiment/LoadExperimentDialog'
import { ExamplesDialog } from '@/features/experiment/ExamplesDialog'
import type { useExperimentSaveWorkflow } from '@/features/experiment/useExperimentSaveWorkflow'
import type { WorkbenchDialog } from './caePageTypes'
import { CaeUtilityDialogs } from './CaeUtilityDialogs'

export function CaeWorkbenchDialogs({ dialog, setDialog, workbench, user, saveWorkflow, guardReplacement, onSaved }: {
  dialog: WorkbenchDialog; setDialog: Dispatch<SetStateAction<WorkbenchDialog>>; workbench: CaeWorkbenchState
  user: UserData | null; saveWorkflow: ReturnType<typeof useExperimentSaveWorkflow>
  guardReplacement: (run: () => unknown | Promise<unknown>) => void; onSaved: () => void
}) {
  return <>
    {dialog === 'save-experiment-as' || dialog === 'save-experiment-version' ? <SaveExperimentDialog
      user={user} workbench={workbench} initialTarget={dialog === 'save-experiment-version' ? workbench.experimentRecord : null}
      capture={saveWorkflow.capture} captureError={saveWorkflow.captureError} includePreflight={saveWorkflow.includePreflight}
      setIncludePreflight={saveWorkflow.setIncludePreflight} preflightId={saveWorkflow.preflightId} preflightReason={saveWorkflow.preflightReason}
      onClose={() => setDialog(null)} onSaved={onSaved} /> : null}
    {dialog === 'load-experiment' ? <LoadExperimentDialog user={user} current={workbench.experimentRecord} onClose={() => setDialog(null)}
      onApply={(row) => { setDialog(null); guardReplacement(() => workbench.loadExperiment(row)) }} /> : null}
    {dialog === 'examples' ? <ExamplesDialog onClose={() => setDialog(null)} onApply={(row) => {
      setDialog(null); guardReplacement(() => workbench.newExperiment(row.sourceBundle, row.title, row.description, row.calculations))
    }} /> : null}
    <CaeUtilityDialogs dialog={dialog} setDialog={setDialog} />
  </>
}
