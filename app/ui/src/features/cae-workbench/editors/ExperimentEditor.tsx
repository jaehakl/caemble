import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
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

function synchronizeExperimentModels(
  monaco: typeof Monaco,
  models: Map<string, Monaco.editor.ITextModel>,
  files: Readonly<Record<string, string>>,
  activePath: string | null,
) {
  const paths = new Set(Object.keys(files))
  Object.entries(files).forEach(([path, source]) => {
    const uri = monaco.Uri.parse(`file:///${path}`)
    const existing = monaco.editor.getModel(uri)
    const model = existing ?? monaco.editor.createModel(source, path.endsWith('.py') ? 'python' : 'typescript', uri)
    if (existing && path !== activePath && model.getValue() !== source) model.setValue(source)
    models.set(path, model)
  })
  models.forEach((model, path) => {
    if (paths.has(path)) return
    monaco.editor.setModelMarkers(model, 'caemble-cad', [])
    model.dispose()
    models.delete(path)
  })
}

function useExperimentMonacoModels(files: Readonly<Record<string, string>> | null, activePath: string | null) {
  const filesRef = useRef(files)
  const activePathRef = useRef(activePath)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const modelsRef = useRef(new Map<string, Monaco.editor.ITextModel>())
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const hasFiles = files !== null
  filesRef.current = files
  activePathRef.current = activePath

  useEffect(() => {
    if (!hasFiles) {
      setReady(false)
      return
    }
    const models = modelsRef.current
    let cancelled = false
    setReady(false)
    setLoadError(null)
    void import('@/lib/cad/authoring')
      .then(({ loadMonaco }) => loadMonaco())
      .then((monaco) => {
        if (cancelled || filesRef.current === null) return
        monacoRef.current = monaco
        synchronizeExperimentModels(monaco, models, filesRef.current, activePathRef.current)
        setReady(true)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
      const monaco = monacoRef.current
      if (monaco) {
        models.forEach((model) => {
          monaco.editor.setModelMarkers(model, 'caemble-cad', [])
          model.dispose()
        })
      }
      models.clear()
      monacoRef.current = null
    }
  }, [hasFiles])

  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco || files === null) return
    synchronizeExperimentModels(monaco, modelsRef.current, files, activePath)
  }, [activePath, files])

  return { loadError, ready }
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
        ? [
            EXPERIMENT_ENTRY_PATH,
            EXPERIMENT_GEOMETRY_PATH,
            EXPERIMENT_MATERIAL_PATH,
            EXPERIMENT_SIMULATION_PATH,
            ...experimentTaskPaths(document.sourceBundle),
          ]
        : [],
    [document],
  )
  const [selectedFile, setSelectedFile] = useState(initialActiveFile ?? EXPERIMENT_ENTRY_PATH)
  const appliedInitialFile = useRef(initialActiveFile)
  const activeFile = filePaths.includes(selectedFile) ? selectedFile : (filePaths[0] ?? null)
  const editorModels = useExperimentMonacoModels(document?.sourceBundle.files ?? null, activeFile)

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
        {editorModels.loadError ? (
          <div className="grid h-full place-items-center bg-rose-50 p-6 text-sm text-rose-700">
            Monaco could not be loaded: {editorModels.loadError}
          </div>
        ) : editorModels.ready ? (
          <CadEditor
            diagnostics={controller.diagnostics.filter((diagnostic) => diagnostic.file === activeFile)}
            key={activeFile}
            language={activeFile === EXPERIMENT_SIMULATION_PATH ? 'python' : 'typescript'}
            modelPath={`file:///${activeFile}`}
            readOnly={controller.sourceReadOnly || disabled}
            value={document.sourceBundle.files[activeFile]}
            onChange={(source) => controller.handleExperimentFileChange(activeFile, source)}
          />
        ) : (
          <div className="grid h-full place-items-center bg-slate-50 text-sm text-slate-500" role="status">
            Editor preparing…
          </div>
        )}
      </div>
      <DocumentFeedback controller={controller} />
    </section>
  )
}
