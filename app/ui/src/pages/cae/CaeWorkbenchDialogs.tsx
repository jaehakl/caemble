import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import type { MeasurementPairListItem } from '@/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DefinitionLineageSummary,
  DefinitionPickerDialog,
  ExamplePickerDialog,
  HistoryDialog,
  MeasurementPickerDialog,
  RealizationPickerDialog,
  ResearchPickerDialog,
} from '@/features/cae-workbench/dialogs'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { SavedExperiment, SavedStructure, WorkbenchTabId } from '@/features/cae-workbench/types'
import { SaveDefinitionDialog } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { AnalysisWorkspace } from '@/pages/analysis/AnalysisPage'
import { MaterialManager } from '@/pages/materials/MaterialManager'
import type { WorkbenchDialog } from './caePageTypes'

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
  guardReplacement: (target: 'experiment' | 'pair' | 'structure', run: () => unknown | Promise<unknown>) => void
  openTab: (tab: WorkbenchTabId) => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const closeDialog = (open: boolean) => !open && setDialog(null)
  const handlePairSelection = (pair: MeasurementPairListItem, mode: 'research' | 'structure' | 'experiment') => {
    if (mode === 'research') {
      guardReplacement('pair', async () => {
        await workbench.loadResearch(pair.structure_id, pair.experiment_id, pair.latest_measurement_id)
        openTab('recorded-data')
      })
    } else if (mode === 'structure') {
      guardReplacement('structure', () => workbench.loadStructure(pair.structure_id))
    } else {
      guardReplacement('experiment', () => workbench.loadExperiment(pair.experiment_id))
    }
  }

  return (
    <>
      <ExamplePickerDialog
        kind="research"
        open={dialog === 'new-research'}
        onOpenChange={closeDialog}
        onSelect={(example) =>
          guardReplacement('pair', () => {
            workbench.newResearch(example)
            openTab('structure')
          })
        }
      />
      <ExamplePickerDialog
        kind="structure"
        open={dialog === 'new-structure'}
        onOpenChange={closeDialog}
        onSelect={(example) =>
          guardReplacement('structure', () => {
            workbench.newStructure(example.structureCode, `${example.title} Structure`, example.description)
            openTab('structure')
          })
        }
      />
      <ExamplePickerDialog
        kind="experiment"
        open={dialog === 'new-experiment'}
        onOpenChange={closeDialog}
        onSelect={(example) =>
          guardReplacement('experiment', () => {
            workbench.newExperiment(example.experimentSourceBundle, `${example.title} Experiment`, example.description)
            openTab('experiment')
          })
        }
      />
      <DefinitionPickerDialog
        authenticated={authenticated}
        kind="structure"
        open={dialog === 'load-structure'}
        selectedId={workbench.structureId}
        onOpenChange={closeDialog}
        onSelect={(row) => guardReplacement('structure', () => workbench.loadStructure(row as SavedStructure))}
      />
      <DefinitionPickerDialog
        authenticated={authenticated}
        kind="experiment"
        open={dialog === 'load-experiment'}
        selectedId={workbench.experimentId}
        onOpenChange={closeDialog}
        onSelect={(row) => guardReplacement('experiment', () => workbench.loadExperiment(row as SavedExperiment))}
      />
      <ResearchPickerDialog
        mode="research"
        open={dialog === 'load-research'}
        onOpenChange={closeDialog}
        onSelect={(pair) => handlePairSelection(pair, 'research')}
      />
      <ResearchPickerDialog
        experimentId={workbench.experimentId}
        mode="other-structures"
        open={dialog === 'other-structures'}
        structureId={workbench.structureId}
        onOpenChange={closeDialog}
        onSelect={(pair) => handlePairSelection(pair, 'structure')}
      />
      <ResearchPickerDialog
        experimentId={workbench.experimentId}
        mode="other-experiments"
        open={dialog === 'other-experiments'}
        structureId={workbench.structureId}
        onOpenChange={closeDialog}
        onSelect={(pair) => handlePairSelection(pair, 'experiment')}
      />
      <HistoryDialog
        id={workbench.structureId}
        kind="structure"
        open={dialog === 'structure-history'}
        onOpenChange={closeDialog}
        onSelect={(id) => guardReplacement('structure', () => workbench.loadStructure(id))}
      />
      <HistoryDialog
        id={workbench.experimentId}
        kind="experiment"
        open={dialog === 'experiment-history'}
        onOpenChange={closeDialog}
        onSelect={(id) => guardReplacement('experiment', () => workbench.loadExperiment(id))}
      />
      <RealizationPickerDialog
        definitionId={workbench.structureId}
        kind="sample"
        open={dialog === 'sample'}
        selectedId={workbench.selection.sample?.id}
        onOpenChange={closeDialog}
        onSelect={(row) => runSafely(() => workbench.selection.selectSample(row as never))}
      />
      <RealizationPickerDialog
        definitionId={workbench.experimentId}
        kind="setup"
        open={dialog === 'setup'}
        selectedId={workbench.selection.setup?.id}
        onOpenChange={closeDialog}
        onSelect={(row) => runSafely(() => workbench.selection.selectSetup(row as never))}
      />
      <MeasurementPickerDialog
        experimentId={workbench.experimentId}
        open={dialog === 'measurement'}
        selectedId={workbench.selection.measurement?.id}
        structureId={workbench.structureId}
        onOpenChange={closeDialog}
        onSelect={(row) => runSafely(() => workbench.selection.loadMeasurement(row.id))}
      />
      <SaveDefinitionDialog
        context={
          dialog === 'save-structure' || dialog === 'save-structure-as' ? (
            <DefinitionLineageSummary
              id={dialog === 'save-structure-as' ? null : workbench.structureId}
              kind="structure"
            />
          ) : null
        }
        defaults={{ name: workbench.structureName, description: workbench.structureDescription }}
        description={
          dialog === 'save-structure-as'
            ? '현재 source를 parent가 없는 새 Structure 계보로 저장합니다.'
            : `현재 source를 저장합니다.${workbench.structureId ? ` 기준 Structure #${workbench.structureId}의 의미가 바뀌면 child로 저장됩니다.` : ''}`
        }
        kind="Structure"
        open={dialog === 'save-structure' || dialog === 'save-structure-as'}
        pending={workbench.saving === 'structure'}
        submitLabel={dialog === 'save-structure-as' ? '새 계보로 저장' : 'Structure 저장'}
        title={dialog === 'save-structure-as' ? 'Save Structure As' : 'Save Structure'}
        onOpenChange={closeDialog}
        onSubmit={async (values) => {
          if (workbench.measurementActions.busy) throw new Error('CAE 작업이 끝난 뒤 source를 저장하세요.')
          const forceRoot = dialog === 'save-structure-as'
          const result = await workbench.saveStructure(values, forceRoot)
          setDialog(null)
          toast.success(
            forceRoot
              ? 'Structure를 새 계보로 저장했습니다.'
              : result.action === 'forked'
                ? '의미 변경을 child Structure로 저장했습니다.'
                : 'Structure를 저장했습니다.',
          )
        }}
      />
      <SaveDefinitionDialog
        context={
          dialog === 'save-experiment' || dialog === 'save-experiment-as' ? (
            <DefinitionLineageSummary
              id={dialog === 'save-experiment-as' ? null : workbench.experimentId}
              kind="experiment"
            />
          ) : null
        }
        defaults={{ name: workbench.experimentName, description: workbench.experimentDescription }}
        description={
          dialog === 'save-experiment-as'
            ? '현재 source bundle을 parent가 없는 새 Experiment 계보로 저장합니다.'
            : `현재 source bundle을 저장합니다.${workbench.experimentId ? ` 기준 Experiment #${workbench.experimentId}의 의미가 바뀌면 child로 저장됩니다.` : ''}`
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
                ? '의미 변경을 child Experiment로 저장했습니다.'
                : 'Experiment를 저장했습니다.',
          )
        }}
      />
      <Dialog open={dialog === 'material'} onOpenChange={closeDialog}>
        <DialogContent className="grid h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle>Material Manager</DialogTitle>
            <DialogDescription>Material 목록과 속성을 조회하고 편집합니다.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto p-4">
            <MaterialManager />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'analysis'} onOpenChange={closeDialog}>
        <DialogContent className="grid h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle>Analyze Measurements</DialogTitle>
            <DialogDescription>현재 Structure + Experiment 조합의 Measurement 데이터를 분석합니다.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto">
            <AnalysisWorkspace embedded experimentId={workbench.experimentId} structureId={workbench.structureId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
