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
import { draftTaskCode } from '@/lib/localExperimentCode'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState, CadEditorRevealRequest } from '@/features/viewer/editor/CadEditor'
import { CadDiffEditor } from '@/features/viewer/editor/CadDiffEditor'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { AgentExperimentChange } from '../state/useCaeWorkbenchState'
import type { CadViewerSelectionQuery } from '@/features/viewer/viewer/selection'
import { cadSourceIdSelectionAtRange } from '@/features/viewer/editor/cadSelectionSource'
import { DocumentFeedback } from './DocumentFeedback'

const protectedCorePaths: readonly string[] = [
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  EXPERIMENT_SIMULATION_PATH,
]

export type ExperimentEditorProps = {
  controller: CadDocumentController
  disabled?: boolean
  document: ExperimentSourceDocument | null
  initialActiveFile?: string | null
  agentChange?: AgentExperimentChange | null
  onUndoAgentChange?: () => Promise<boolean>
  onActiveFileChange?: (path: string) => void
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
  onSourceRevealRequestHandled?: (id: number) => void
  onViewerSelectionQueryChange?: (query: CadViewerSelectionQuery | null) => void
  sourceRevealRequest?: (CadEditorRevealRequest & Readonly<{ path: string }>) | null
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
  agentChange = null,
  onUndoAgentChange,
  onActiveFileChange,
  onAuthoringStateChange,
  onSourceRevealRequestHandled,
  onViewerSelectionQueryChange,
  sourceRevealRequest = null,
}: ExperimentEditorProps) {
  const filePaths = useMemo(
    () =>
      document
        ? (() => {
            const core = [
              EXPERIMENT_ENTRY_PATH,
              EXPERIMENT_GEOMETRY_PATH,
              EXPERIMENT_MATERIAL_PATH,
              EXPERIMENT_SIMULATION_PATH,
            ].filter((path) => path in document.sourceBundle.files)
            const tasks = experimentTaskPaths(document.sourceBundle)
            const known = new Set([...core, ...tasks])
            const additional = [
              ...new Set([
                ...Object.keys(document.sourceBundle.files),
                ...(agentChange?.files.map((file) => file.path) ?? []),
              ]),
            ]
              .filter((path) => !known.has(path))
              .sort()
            return [...core, ...tasks, ...additional]
          })()
        : [],
    [agentChange, document],
  )
  const [selectedFile, setSelectedFile] = useState(initialActiveFile ?? EXPERIMENT_ENTRY_PATH)
  const [showAgentDiff, setShowAgentDiff] = useState(true)
  const appliedInitialFile = useRef(initialActiveFile)
  const activeFile = filePaths.includes(selectedFile) ? selectedFile : (filePaths[0] ?? null)
  const editorModels = useExperimentMonacoModels(document?.sourceBundle.files ?? null, activeFile)
  const agentFileChange = agentChange?.files.find((file) => file.path === activeFile) ?? null
  const conflictReview = agentChange?.status === 'conflicted'
  const activeTaskName = activeFile ? experimentTaskName(activeFile) : null
  const isTask = activeTaskName !== null
  const supportsGeometryAuthoring =
    activeFile === EXPERIMENT_ENTRY_PATH || activeFile === EXPERIMENT_GEOMETRY_PATH || isTask
  const supportsViewerSelection = Boolean(
    activeFile && activeFile.endsWith('.tsx') && activeFile !== EXPERIMENT_MATERIAL_PATH,
  )

  useEffect(() => {
    if (agentChange) setShowAgentDiff(true)
  }, [agentChange])

  useEffect(() => {
    if (initialActiveFile === appliedInitialFile.current) return
    appliedInitialFile.current = initialActiveFile
    if (initialActiveFile && filePaths.includes(initialActiveFile)) setSelectedFile(initialActiveFile)
  }, [filePaths, initialActiveFile])

  useEffect(() => {
    if (activeFile && activeFile !== selectedFile) onActiveFileChange?.(activeFile)
  }, [activeFile, onActiveFileChange, selectedFile])

  useEffect(() => {
    if (!supportsGeometryAuthoring) onAuthoringStateChange?.(null)
  }, [onAuthoringStateChange, supportsGeometryAuthoring])

  useEffect(() => {
    if (!supportsViewerSelection || (agentChange && agentFileChange && showAgentDiff)) {
      onViewerSelectionQueryChange?.(null)
    }
  }, [agentChange, agentFileChange, onViewerSelectionQueryChange, showAgentDiff, supportsViewerSelection])

  useEffect(() => {
    if (!sourceRevealRequest || !filePaths.includes(sourceRevealRequest.path)) return
    setSelectedFile(sourceRevealRequest.path)
    setShowAgentDiff(false)
  }, [filePaths, sourceRevealRequest])

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
    controller.handleAddExperimentTask(trimmed, draftTaskCode)
    selectFile(path)
  }

  const addFile = () => {
    const value = window.prompt('번들에 추가할 .ts 또는 .tsx 상대 경로를 입력하세요. 예: lib/profile.ts')
    if (value === null) return
    const path = value.trim().replace(/\\/gu, '/')
    if (!path) {
      window.alert('파일 경로를 입력하세요.')
      return
    }
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) {
      window.alert('추가 파일은 .ts 또는 .tsx만 사용할 수 있습니다.')
      return
    }
    if (path in document.sourceBundle.files) {
      window.alert('같은 경로의 파일이 이미 있습니다.')
      return
    }
    try {
      controller.handleAddExperimentFile(path, 'export {}\n')
      selectFile(path)
    } catch (cause: unknown) {
      window.alert(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteFile = () => {
    const taskName = experimentTaskName(activeFile)
    if (protectedCorePaths.includes(activeFile)) return
    const label = taskName ? `${taskName} Task` : activeFile
    if (!window.confirm(`${label}를 삭제할까요? 다른 파일의 import나 simulate.py 참조는 자동으로 변경되지 않습니다.`)) {
      return
    }
    if (taskName) controller.handleRemoveExperimentTask(taskName)
    else controller.handleRemoveExperimentFile(activeFile)
    selectFile(EXPERIMENT_ENTRY_PATH)
  }
  const isProtectedCore = protectedCorePaths.includes(activeFile)

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
              {agentChange?.files.some((file) => file.path === path) ? (
                <span
                  className={`ml-1 text-[10px] font-semibold ${conflictReview ? 'text-amber-700' : 'text-emerald-700'}`}
                >
                  {conflictReview ? 'AI staged' : 'AI 미검증'}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {agentChange ? (
            <>
              {agentFileChange ? (
                <span className="font-mono text-[11px] text-slate-500">
                  <span className="text-emerald-700">+{agentFileChange.addedLines}</span>{' '}
                  <span className="text-rose-700">-{agentFileChange.removedLines}</span>
                </span>
              ) : null}
              {agentChange.files.length ? (
                <button
                  className="rounded border border-sky-200 bg-white px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50"
                  type="button"
                  onClick={() => setShowAgentDiff((current) => !current)}
                >
                  {showAgentDiff ? '편집 보기' : 'AI Diff'}
                </button>
              ) : (
                <span className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700">
                  {conflictReview ? 'Source staged 충돌' : '미검증 Source 갱신'}
                </span>
              )}
              <button
                className="rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
                type="button"
                onClick={() => void onUndoAgentChange?.()}
              >
                {conflictReview ? 'AI staged diff 닫기' : 'AI 변경 전체 Undo'}
              </button>
            </>
          ) : null}
          {!isProtectedCore && activeFile in document.sourceBundle.files ? (
            <button
              className="rounded border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={controller.sourceReadOnly || disabled}
              type="button"
              onClick={deleteFile}
            >
              {isTask ? 'Task 삭제' : 'File 삭제'}
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
          <button
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={controller.sourceReadOnly || disabled}
            type="button"
            onClick={addFile}
          >
            + File
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1" role="tabpanel">
        {editorModels.loadError ? (
          <div className="grid h-full place-items-center bg-rose-50 p-6 text-sm text-rose-700">
            Monaco could not be loaded: {editorModels.loadError}
          </div>
        ) : editorModels.ready && agentChange && agentFileChange && showAgentDiff ? (
          <CadDiffEditor
            changeId={`${agentChange.runId}-${agentChange.appliedAt}`}
            diagnostics={controller.diagnostics.filter((diagnostic) => diagnostic.file === activeFile)}
            key={`${agentChange.runId}-${activeFile}`}
            language={activeFile === EXPERIMENT_SIMULATION_PATH ? 'python' : 'typescript'}
            modelPath={
              conflictReview
                ? `inmemory://caemble-agent-conflict/${encodeURIComponent(agentChange.runId)}/${activeFile}`
                : `file:///${activeFile}`
            }
            modified={conflictReview ? (agentFileChange.after ?? '') : (document.sourceBundle.files[activeFile] ?? '')}
            original={conflictReview ? (document.sourceBundle.files[activeFile] ?? '') : (agentFileChange.before ?? '')}
            readOnly={conflictReview || agentFileChange.after === null || controller.sourceReadOnly || disabled}
            onChange={
              conflictReview ? () => undefined : (source) => controller.handleExperimentFileChange(activeFile, source)
            }
          />
        ) : editorModels.ready && activeFile in document.sourceBundle.files ? (
          <CadEditor
            diagnostics={controller.diagnostics.filter((diagnostic) => diagnostic.file === activeFile)}
            key={activeFile}
            language={activeFile === EXPERIMENT_SIMULATION_PATH ? 'python' : 'typescript'}
            modelPath={`file:///${activeFile}`}
            onAuthoringStateChange={supportsGeometryAuthoring ? onAuthoringStateChange : undefined}
            onRevealRequestHandled={onSourceRevealRequestHandled}
            onSelectionOffsetChange={
              supportsViewerSelection
                ? (range) => {
                    const selected = range
                      ? cadSourceIdSelectionAtRange(document.sourceBundle.files[activeFile] ?? '', activeFile, range)
                      : null
                    onViewerSelectionQueryChange?.(
                      selected
                        ? {
                            ...selected,
                            origin: 'code',
                            scope:
                              activeFile === EXPERIMENT_ENTRY_PATH
                                ? { source: 'experiment' }
                                : activeTaskName
                                  ? { source: 'task', taskName: activeTaskName }
                                  : { source: 'visible' },
                          }
                        : null,
                    )
                  }
                : undefined
            }
            readOnly={controller.sourceReadOnly || disabled}
            revealRequest={sourceRevealRequest?.path === activeFile ? sourceRevealRequest : null}
            value={document.sourceBundle.files[activeFile] ?? ''}
            onChange={(source) => controller.handleExperimentFileChange(activeFile, source)}
          />
        ) : editorModels.ready ? (
          <div className="grid h-full place-items-center bg-slate-50 p-6 text-sm text-slate-500">
            이 파일은 AI Agent 변경에서 삭제되었습니다. AI Diff로 삭제 전 내용을 확인할 수 있습니다.
          </div>
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
