import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { CadDiagnostic } from '@/lib/cad'

type CadDiffEditorProps = {
  changeId: string
  diagnostics?: readonly CadDiagnostic[]
  language?: 'python' | 'typescript'
  modelPath: string
  modified: string
  onChange: (value: string) => void
  original: string
  readOnly?: boolean
}

export function CadDiffEditor({
  changeId,
  diagnostics = [],
  language = 'typescript',
  modelPath,
  modified,
  onChange,
  original,
  readOnly = false,
}: CadDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const onChangeRef = useRef(onChange)
  const modifiedRef = useRef(modified)
  const diagnosticsRef = useRef(diagnostics)
  const readOnlyRef = useRef(readOnly)
  const [loadError, setLoadError] = useState<string | null>(null)
  onChangeRef.current = onChange
  diagnosticsRef.current = diagnostics
  readOnlyRef.current = readOnly

  useEffect(() => {
    let disposed = false
    let subscription: Monaco.IDisposable | null = null
    let originalModel: Monaco.editor.ITextModel | null = null
    let ownedModifiedModel: Monaco.editor.ITextModel | null = null

    void import('@/lib/cad/authoring')
      .then(({ loadMonaco }) => loadMonaco())
      .then((monaco) => {
        if (disposed || !containerRef.current) return
        const modifiedUri = monaco.Uri.parse(modelPath)
        const existingModifiedModel = monaco.editor.getModel(modifiedUri)
        const modifiedModel =
          existingModifiedModel ?? monaco.editor.createModel(modifiedRef.current, language, modifiedUri)
        if (!existingModifiedModel) ownedModifiedModel = modifiedModel
        if (modifiedModel.getValue() !== modifiedRef.current) modifiedModel.setValue(modifiedRef.current)
        originalModel = monaco.editor.createModel(
          original,
          language,
          monaco.Uri.parse(`inmemory://caemble-agent-review/${encodeURIComponent(changeId)}/${modelPath}`),
        )
        const editor = monaco.editor.createDiffEditor(containerRef.current, {
          automaticLayout: true,
          fontFamily: 'JetBrains Mono, Consolas, Monaco, monospace',
          fontSize: 13,
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: readOnlyRef.current,
          renderSideBySide: true,
          scrollBeyondLastLine: false,
          theme: 'vs-light',
          wordWrap: 'on',
        })
        editor.setModel({ original: originalModel, modified: modifiedModel })
        monaco.editor.setModelMarkers(
          modifiedModel,
          'caemble-cad',
          diagnosticsRef.current.map((diagnostic) => ({
            ...diagnostic.range,
            code: String(diagnostic.code),
            message: diagnostic.message,
            severity:
              diagnostic.severity === 'error'
                ? monaco.MarkerSeverity.Error
                : diagnostic.severity === 'warning'
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
            source: `caemble-${diagnostic.phase}`,
          })),
        )
        monacoRef.current = monaco
        editorRef.current = editor
        subscription = modifiedModel.onDidChangeContent(() => {
          const value = modifiedModel.getValue()
          if (value === modifiedRef.current) return
          modifiedRef.current = value
          onChangeRef.current(value)
        })
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      disposed = true
      subscription?.dispose()
      editorRef.current?.dispose()
      originalModel?.dispose()
      ownedModifiedModel?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
  }, [changeId, language, modelPath, original])

  useEffect(() => {
    modifiedRef.current = modified
    const model = editorRef.current?.getModel()?.modified
    if (model && model.getValue() !== modified) model.setValue(modified)
  }, [modified])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()?.modified
    if (!monaco || !model) return
    monaco.editor.setModelMarkers(
      model,
      'caemble-cad',
      diagnostics.map((diagnostic) => ({
        ...diagnostic.range,
        code: String(diagnostic.code),
        message: diagnostic.message,
        severity:
          diagnostic.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : diagnostic.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        source: `caemble-${diagnostic.phase}`,
      })),
    )
  }, [diagnostics])

  return (
    <div className="relative h-full min-h-0">
      <div className="h-full" ref={containerRef} />
      {loadError ? (
        <div className="absolute inset-0 grid place-items-center bg-rose-50 p-6 text-sm text-rose-700">
          Monaco diff editor could not be loaded: {loadError}
        </div>
      ) : null}
    </div>
  )
}
