import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_SIMULATION_PATH,
  cadSource,
  experimentTaskName,
  experimentTaskPaths,
  type CadDocumentType,
  type CadSourceDocument,
} from '@/lib/cad'
import CadEditor from '../editor/CadEditor'
import type { CadDocumentController } from './useCadWorkspace'

export type StructureExperimentViewerProps = {
  activeDocumentType: CadDocumentType | null
  structure?: CadSourceDocument | null
  experiment?: CadSourceDocument | null
  experimentLineage?: ReactNode
  structureDocument: CadDocumentController
  experimentDocument: CadDocumentController
  structureLineage?: ReactNode
  structureVarsPanel?: ReactNode
  onActiveDocumentTypeChange: (documentType: CadDocumentType) => void
  onActiveExperimentTaskChange?: (taskName: string | null) => void
}

type WorkspaceTab = Readonly<{
  id: string
  documentType: CadDocumentType
  label: string
  panel: 'lineage' | 'program' | 'source' | 'task' | 'vars'
  taskName?: string
  taskPath?: string
}>

const newTaskSource = `import { defineTask } from '@caemble/core'

export default defineTask({
  kernel: { name: 'solver-name', version: '0.0.0' },
  lengthUnit: 'mm',
  geometry: () => null,
  config: () => ({
    parameters: {},
    initializations: [],
    boundaryConditions: [],
    outputs: [],
  }),
})
`

function Status({ document }: { document: CadDocumentController }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          document.status === 'Error' ? 'bg-rose-500' : document.status === 'Ready' ? 'bg-emerald-500' : 'bg-amber-500'
        }`}
      />
      <span className="font-medium text-slate-700">{document.status}</span>
    </div>
  )
}

export function StructureExperimentViewer({
  activeDocumentType,
  experiment,
  experimentDocument,
  experimentLineage,
  onActiveDocumentTypeChange,
  onActiveExperimentTaskChange,
  structure,
  structureDocument,
  structureLineage,
  structureVarsPanel,
}: StructureExperimentViewerProps) {
  const structureSource = structure?.kind === 'structure' ? structure : null
  const experimentSource = experiment?.kind === 'experiment' ? experiment : null
  const hasStructure = structureSource !== null
  const hasExperiment = experimentSource !== null
  const taskPaths = useMemo(
    () => (experimentSource ? experimentTaskPaths(experimentSource.sourceBundle) : []),
    [experimentSource],
  )
  const availableTabs = useMemo<readonly WorkspaceTab[]>(
    () => [
      ...(hasStructure
        ? [
            { id: 'structure-source', documentType: 'structure', panel: 'source', label: 'Structure' } as const,
            ...(structureVarsPanel === undefined
              ? []
              : [{ id: 'structure-vars', documentType: 'structure', panel: 'vars', label: 'Structure Vars' } as const]),
            ...(structureLineage === undefined
              ? []
              : [
                  { id: 'structure-lineage', documentType: 'structure', panel: 'lineage', label: '족보 보기' } as const,
                ]),
          ]
        : []),
      ...(hasExperiment
        ? [
            { id: 'experiment-program', documentType: 'experiment', panel: 'program', label: 'Experiment' } as const,
            ...taskPaths.map((taskPath) => {
              const taskName = experimentTaskName(taskPath)!
              return {
                id: `experiment-task-${taskName}`,
                documentType: 'experiment' as const,
                panel: 'task' as const,
                label: taskName,
                taskName,
                taskPath,
              }
            }),
            ...(experimentLineage === undefined
              ? []
              : [
                  {
                    id: 'experiment-lineage',
                    documentType: 'experiment',
                    panel: 'lineage',
                    label: '족보 보기',
                  } as const,
                ]),
          ]
        : []),
    ],
    [experimentLineage, hasExperiment, hasStructure, structureLineage, structureVarsPanel, taskPaths],
  )
  const [activeTab, setActiveTab] = useState<string | null>(() =>
    activeDocumentType === 'experiment' && hasExperiment
      ? 'experiment-program'
      : hasStructure
        ? 'structure-source'
        : hasExperiment
          ? 'experiment-program'
          : null,
  )
  const selectedTab = availableTabs.find((tab) => tab.id === activeTab) ?? availableTabs[0] ?? null
  const activeDocument =
    selectedTab?.documentType === 'structure'
      ? structureDocument
      : selectedTab?.documentType === 'experiment'
        ? experimentDocument
        : null

  useEffect(() => {
    if (activeTab !== selectedTab?.id) setActiveTab(selectedTab?.id ?? null)
    if (selectedTab && selectedTab.documentType !== activeDocumentType) {
      onActiveDocumentTypeChange(selectedTab.documentType)
    }
    onActiveExperimentTaskChange?.(selectedTab?.panel === 'task' ? (selectedTab.taskName ?? null) : null)
  }, [activeDocumentType, activeTab, onActiveDocumentTypeChange, onActiveExperimentTaskChange, selectedTab])

  if (!activeDocument) {
    return (
      <section
        aria-label="Structure and Experiment workspace"
        className="grid h-full min-h-[360px] place-items-center bg-slate-50 px-6 py-16 text-center lg:min-h-0 lg:overflow-hidden"
      >
        <div>
          <h2 className="text-base font-semibold text-slate-800">No modeling source</h2>
          <p className="mt-2 text-sm text-slate-500">Provide a Structure or Experiment source to open the workspace.</p>
        </div>
      </section>
    )
  }

  const addTask = () => {
    if (!experimentSource) return
    const taskName = window.prompt(
      '새 Task 이름을 입력하세요. 영문자로 시작하고 영문자, 숫자, _, -만 사용할 수 있습니다.',
    )
    if (taskName === null) return
    const trimmed = taskName.trim()
    const path = `tasks/${trimmed}.tsx`
    if (experimentTaskName(path) !== trimmed) {
      window.alert('Task 이름이 올바르지 않습니다.')
      return
    }
    if (path in experimentSource.sourceBundle.files) {
      window.alert('같은 이름의 Task가 이미 있습니다.')
      return
    }
    experimentDocument.handleAddExperimentTask(trimmed, newTaskSource)
    setActiveTab(`experiment-task-${trimmed}`)
  }

  const removeTask = () => {
    if (!experimentSource || selectedTab?.panel !== 'task' || !selectedTab.taskName || taskPaths.length <= 1) return
    if (!window.confirm(`${selectedTab.taskName} Task를 삭제할까요? simulate.py 참조는 자동 변경되지 않습니다.`)) return
    experimentDocument.handleRemoveExperimentTask(selectedTab.taskName)
    setActiveTab('experiment-program')
  }

  return (
    <section
      aria-label="Structure and Experiment workspace"
      className="flex h-full min-h-[360px] min-w-0 flex-col bg-white lg:min-h-0 lg:overflow-hidden"
    >
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3">
        <div
          aria-label="Structure and Experiment panels"
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {availableTabs.map((tab) => (
            <button
              aria-controls={`${tab.id}-panel`}
              aria-selected={selectedTab?.id === tab.id}
              className={`h-12 shrink-0 border-b-2 px-3 text-xs font-semibold tracking-wide uppercase ${
                selectedTab?.id === tab.id
                  ? 'border-slate-900 text-slate-950'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              id={`${tab.id}-tab`}
              key={tab.id}
              role="tab"
              tabIndex={selectedTab?.id === tab.id ? 0 : -1}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          {hasExperiment ? (
            <button
              aria-label="Task 추가"
              className="h-8 shrink-0 rounded border px-2 text-sm text-slate-600 hover:bg-slate-50"
              disabled={experimentDocument.sourceReadOnly}
              type="button"
              onClick={addTask}
            >
              + Task
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-3 pb-1 text-sm sm:pb-0">
          {selectedTab?.panel === 'task' ? (
            <button
              className="rounded border border-rose-200 px-2 py-1.5 text-xs font-medium text-rose-700 disabled:opacity-40"
              disabled={experimentDocument.sourceReadOnly || taskPaths.length <= 1}
              type="button"
              onClick={removeTask}
            >
              Task 삭제
            </button>
          ) : null}
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <span>Limit</span>
            <select
              aria-label="Model evaluation timeout"
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50"
              disabled={activeDocument.runIsBusy}
              value={activeDocument.evaluationTimeoutMs}
              onChange={(event) =>
                activeDocument.setEvaluationTimeoutMs(Number(event.target.value) as 3000 | 10000 | 30000)
              }
            >
              <option value={3000}>3 s</option>
              <option value={10000}>10 s</option>
              <option value={30000}>30 s</option>
            </select>
          </label>
          <button
            aria-label={`Reroll ${activeDocument.documentType}`}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={activeDocument.runIsBusy}
            title={`Re-evaluate and randomize the current ${activeDocument.documentType}`}
            type="button"
            onClick={activeDocument.handleReroll}
          >
            Reroll
          </button>
          <Status document={activeDocument} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {selectedTab?.panel === 'lineage' ? (
          selectedTab.documentType === 'structure' ? (
            structureLineage
          ) : (
            experimentLineage
          )
        ) : selectedTab?.panel === 'vars' ? (
          structureVarsPanel
        ) : selectedTab?.panel === 'source' && structureSource ? (
          <CadEditor
            diagnostics={structureDocument.diagnostics.filter((diagnostic) => diagnostic.file === 'structure.tsx')}
            modelPath="file:///structure.tsx"
            readOnly={structureDocument.sourceReadOnly}
            value={cadSource(structureSource)}
            onChange={structureDocument.handleSourceChange}
          />
        ) : selectedTab?.panel === 'program' && experimentSource ? (
          <div className="grid h-full min-h-0 grid-rows-2 divide-y">
            <div className="flex min-h-0 flex-col">
              <div className="shrink-0 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">experiment.tsx</div>
              <div className="min-h-0 flex-1">
                <CadEditor
                  diagnostics={experimentDocument.diagnostics.filter(
                    (diagnostic) => diagnostic.file === EXPERIMENT_ENTRY_PATH,
                  )}
                  modelPath="file:///experiment.tsx"
                  readOnly={experimentDocument.sourceReadOnly}
                  value={experimentSource.sourceBundle.files[EXPERIMENT_ENTRY_PATH]}
                  onChange={(source) => experimentDocument.handleExperimentFileChange(EXPERIMENT_ENTRY_PATH, source)}
                />
              </div>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="shrink-0 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">simulate.py</div>
              <div className="min-h-0 flex-1">
                <CadEditor
                  language="python"
                  modelPath="file:///simulate.py"
                  readOnly={experimentDocument.sourceReadOnly}
                  value={experimentSource.sourceBundle.files[EXPERIMENT_SIMULATION_PATH]}
                  onChange={(source) =>
                    experimentDocument.handleExperimentFileChange(EXPERIMENT_SIMULATION_PATH, source)
                  }
                />
              </div>
            </div>
          </div>
        ) : selectedTab?.panel === 'task' && experimentSource && selectedTab.taskPath ? (
          <CadEditor
            diagnostics={experimentDocument.diagnostics.filter(
              (diagnostic) => diagnostic.file === selectedTab.taskPath,
            )}
            modelPath={`file:///${selectedTab.taskPath}`}
            readOnly={experimentDocument.sourceReadOnly}
            value={experimentSource.sourceBundle.files[selectedTab.taskPath]}
            onChange={(source) => experimentDocument.handleExperimentFileChange(selectedTab.taskPath!, source)}
          />
        ) : null}
      </div>

      <footer className="min-h-24 shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">
        {activeDocument.error ? (
          <div className="max-h-36 overflow-auto">
            <div className="text-sm font-semibold text-rose-700">{activeDocument.error.title}</div>
            <pre className="mt-1 text-xs leading-5 whitespace-pre-wrap text-slate-700">
              {activeDocument.error.message}
              {activeDocument.error.stack ? `\n\n${activeDocument.error.stack}` : ''}
            </pre>
          </div>
        ) : activeDocument.materialWarnings.length > 0 ? (
          <div className="max-h-36 overflow-auto text-amber-900" role="status">
            <div className="text-sm font-semibold">Preview ready · Material warning</div>
            <p className="mt-1 text-xs leading-5">{activeDocument.materialWarnings[0]}</p>
          </div>
        ) : (
          <div className="text-sm text-slate-600">
            {activeDocument.documentType === 'structure'
              ? 'Edit the Structure definition. Successful geometry remains visible while new errors are shown here.'
              : 'Program defines shared vars and RecordedData. Each Task owns its geometry, length unit, and kernel config.'}
          </div>
        )}
      </footer>
    </section>
  )
}
