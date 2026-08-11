import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_SIMULATION_PATH,
  experimentTaskName,
  experimentTaskPaths,
  type ExperimentSourceDocument,
} from '@/lib/cad'
import { defaultExperimentTaskCode } from '@/lib/defaultExperimentProgramCode'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { DocumentFeedback } from './DocumentFeedback'

export type ExperimentEditorProps = {
  controller: CadDocumentController
  disabled?: boolean
  document: ExperimentSourceDocument | null
  initialActiveFile?: string | null
  onActiveFileChange?: (path: string) => void
}

export function ExperimentEditor({
  controller,
  disabled = false,
  document,
  initialActiveFile,
  onActiveFileChange,
}: ExperimentEditorProps) {
  const filePaths = useMemo(
    () =>
      document
        ? [EXPERIMENT_ENTRY_PATH, EXPERIMENT_SIMULATION_PATH, ...experimentTaskPaths(document.sourceBundle)]
        : [],
    [document],
  )
  const [selectedFile, setSelectedFile] = useState(initialActiveFile ?? EXPERIMENT_ENTRY_PATH)
  const appliedInitialFile = useRef(initialActiveFile)
  const activeFile = filePaths.includes(selectedFile) ? selectedFile : (filePaths[0] ?? null)

  useEffect(() => {
    if (initialActiveFile === appliedInitialFile.current) return
    appliedInitialFile.current = initialActiveFile
    if (initialActiveFile && filePaths.includes(initialActiveFile)) setSelectedFile(initialActiveFile)
  }, [filePaths, initialActiveFile])

  useEffect(() => {
    if (activeFile && activeFile !== selectedFile) onActiveFileChange?.(activeFile)
  }, [activeFile, onActiveFileChange, selectedFile])

  if (!document || !activeFile) {
    return (
      <section
        aria-label="Experiment editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Experiment가 열려 있지 않습니다</h2>
          <p className="mt-1 text-sm text-slate-500">
            Source 메뉴에서 새 Experiment를 만들거나 저장된 항목을 불러오세요.
          </p>
        </div>
      </section>
    )
  }

  const selectFile = (path: string) => {
    setSelectedFile(path)
    onActiveFileChange?.(path)
  }

  const addTask = () => {
    const taskName = window.prompt(
      '추가할 Task 이름을 입력하세요. 영문자로 시작하고 영문자, 숫자, _, -만 사용할 수 있습니다.',
    )
    if (taskName === null) return
    const trimmed = taskName.trim()
    const path = `tasks/${trimmed}.tsx`
    if (experimentTaskName(path) !== trimmed) {
      window.alert('올바른 Task 이름을 입력하세요.')
      return
    }
    if (path in document.sourceBundle.files) {
      window.alert('같은 이름의 Task가 이미 있습니다.')
      return
    }
    controller.handleAddExperimentTask(trimmed, defaultExperimentTaskCode)
    selectFile(path)
  }

  const deleteTask = () => {
    const taskName = experimentTaskName(activeFile)
    if (!taskName || filePaths.filter((path) => experimentTaskName(path) !== null).length <= 1) return
    if (!window.confirm(`${taskName} Task를 삭제할까요? simulate.py의 참조는 자동으로 변경되지 않습니다.`)) return
    controller.handleRemoveExperimentTask(taskName)
    selectFile(EXPERIMENT_ENTRY_PATH)
  }

  const isTask = experimentTaskName(activeFile) !== null
  const taskCount = filePaths.filter((path) => experimentTaskName(path) !== null).length

  return (
    <section aria-label="Experiment editor" className="flex h-full min-h-0 min-w-0 flex-col bg-white">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-2">
        <div aria-label="Experiment files" className="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="tablist">
          {filePaths.map((path) => (
            <button
              aria-selected={path === activeFile}
              className={`h-11 shrink-0 border-b-2 px-3 font-mono text-xs ${
                path === activeFile
                  ? 'border-sky-600 bg-white font-semibold text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              key={path}
              role="tab"
              tabIndex={path === activeFile ? 0 : -1}
              title={path}
              type="button"
              onClick={() => selectFile(path)}
            >
              {path}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isTask ? (
            <button
              className="rounded border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={controller.sourceReadOnly || disabled || taskCount <= 1}
              type="button"
              onClick={deleteTask}
            >
              Task 삭제
            </button>
          ) : null}
          <button
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={controller.sourceReadOnly || disabled}
            type="button"
            onClick={addTask}
          >
            + Task
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1" role="tabpanel">
        <CadEditor
          diagnostics={controller.diagnostics.filter((diagnostic) => diagnostic.file === activeFile)}
          key={activeFile}
          language={activeFile === EXPERIMENT_SIMULATION_PATH ? 'python' : 'typescript'}
          modelPath={`file:///${activeFile}`}
          readOnly={controller.sourceReadOnly || disabled}
          value={document.sourceBundle.files[activeFile]}
          onChange={(source) => controller.handleExperimentFileChange(activeFile, source)}
        />
      </div>
      <DocumentFeedback controller={controller} />
    </section>
  )
}
