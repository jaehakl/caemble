import type { Dispatch, SetStateAction } from 'react'
import type { UserData } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { SaveExperimentDialog } from '@/features/experiment/SaveExperimentDialog'
import { TemplatesDialog } from '@/features/experiment/TemplatesDialog'
import type { useExperimentSaveWorkflow } from '@/features/experiment/useExperimentSaveWorkflow'
import type { WorkbenchDialog } from './caePageTypes'
import { ExperimentInfoDialog } from './dialogs'

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
    {dialog === 'templates' ? <TemplatesDialog user={user} onClose={() => setDialog(null)} onApply={(row) => {
      setDialog(null); guardReplacement(() => workbench.newExperiment(row.sourceBundle, row.title, row.description, row.calculations))
    }} /> : null}
    {dialog === 'experiment-info' ? (
      <ExperimentInfoDialog workbench={workbench} onClose={() => setDialog(null)} />
    ) : null}
  </>
}
