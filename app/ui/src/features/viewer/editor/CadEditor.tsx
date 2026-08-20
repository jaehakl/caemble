import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { CadDiagnostic } from '@/lib/cad'

type CadEditorProps = {
  diagnostics?: readonly CadDiagnostic[]
  disposeModelOnUnmount?: boolean
  language?: 'python' | 'typescript'
  modelPath: string
  onChange: (value: string) => void
  onCursorOffsetChange?: (offset: number) => void
  readOnly?: boolean
  value: string
}

function markerData(monaco: typeof Monaco, diagnostics: readonly CadDiagnostic[]) {
  return diagnostics.map((diagnostic) => ({
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
  }))
}

function CadEditor({
  diagnostics = [],
  disposeModelOnUnmount = false,
  language = 'typescript',
  modelPath,
  onChange,
  onCursorOffsetChange,
  readOnly = false,
  value,
}: CadEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorOffsetChangeRef = useRef(onCursorOffsetChange)
  const diagnosticsRef = useRef(diagnostics)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const readOnlyRef = useRef(readOnly)
  const valueRef = useRef(value)
  const [loadError, setLoadError] = useState<string | null>(null)

  onChangeRef.current = onChange
  onCursorOffsetChangeRef.current = onCursorOffsetChange
  diagnosticsRef.current = diagnostics
  readOnlyRef.current = readOnly

  useEffect(() => {
    let disposed = false
    let contentSubscription: Monaco.IDisposable | null = null
    let cursorSubscription: Monaco.IDisposable | null = null
    let editorModel: Monaco.editor.ITextModel | null = null

    void import('@/lib/cad/authoring')
      .then(({ loadMonaco }) => loadMonaco())
      .then((monaco) => {
        if (disposed || !containerRef.current) return
        const uri = monaco.Uri.parse(modelPath)
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(valueRef.current, language, uri)
        editorModel = model
        if (model.getValue() !== valueRef.current) model.setValue(valueRef.current)
        const editor = monaco.editor.create(containerRef.current, {
          automaticLayout: true,
          fontFamily: 'JetBrains Mono, Consolas, Monaco, monospace',
          fontSize: 13,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          model,
          padding: { top: 14 },
          readOnly: readOnlyRef.current,
          scrollBeyondLastLine: false,
          tabSize: language === 'python' ? 4 : 2,
          theme: 'vs-light',
          wordWrap: 'on',
        })
        monacoRef.current = monaco
        editorRef.current = editor
        monaco.editor.setModelMarkers(model, 'caemble-cad', markerData(monaco, diagnosticsRef.current))
        contentSubscription = model.onDidChangeContent(() => {
          const nextValue = model.getValue()
          if (nextValue === valueRef.current) return
          valueRef.current = nextValue
          onChangeRef.current(nextValue)
        })
        cursorSubscription = editor.onDidChangeCursorPosition(({ position }) => {
          onCursorOffsetChangeRef.current?.(model.getOffsetAt(position))
        })
        const initialPosition = editor.getPosition()
        if (initialPosition) onCursorOffsetChangeRef.current?.(model.getOffsetAt(initialPosition))
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      disposed = true
      contentSubscription?.dispose()
      cursorSubscription?.dispose()
      editorRef.current?.dispose()
      if (disposeModelOnUnmount) editorModel?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
  }, [disposeModelOnUnmount, language, modelPath])

  useEffect(() => {
    valueRef.current = value
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== value) model.setValue(value)
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()
    if (!monaco || !model) return
    monaco.editor.setModelMarkers(model, 'caemble-cad', markerData(monaco, diagnostics))
  }, [diagnostics])

  return (
    <div className="relative h-full min-h-0">
      <div className="h-full" ref={containerRef} />
      {loadError ? (
        <div className="absolute inset-0 grid place-items-center bg-rose-50 p-6 text-sm text-rose-700">
          Monaco could not be loaded: {loadError}
        </div>
      ) : null}
    </div>
  )
}

export default CadEditor
