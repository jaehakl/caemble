import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { CadDiagnostic } from '@/lib/cad'

type CadEditorProps = {
  diagnostics?: readonly CadDiagnostic[]
  language?: 'python' | 'typescript'
  modelPath: string
  onChange: (value: string) => void
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
  language = 'typescript',
  modelPath,
  onChange,
  readOnly = false,
  value,
}: CadEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const diagnosticsRef = useRef(diagnostics)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const readOnlyRef = useRef(readOnly)
  const valueRef = useRef(value)
  const [loadError, setLoadError] = useState<string | null>(null)

  onChangeRef.current = onChange
  diagnosticsRef.current = diagnostics
  readOnlyRef.current = readOnly

  useEffect(() => {
    let disposed = false
    let subscription: Monaco.IDisposable | null = null

    void import('@/lib/cad/authoring')
      .then(({ loadMonaco }) => loadMonaco())
      .then((monaco) => {
        if (disposed || !containerRef.current) return
        const uri = monaco.Uri.parse(modelPath)
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(valueRef.current, language, uri)
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
        subscription = model.onDidChangeContent(() => {
          const nextValue = model.getValue()
          if (nextValue === valueRef.current) return
          valueRef.current = nextValue
          onChangeRef.current(nextValue)
        })
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      disposed = true
      subscription?.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
  }, [language, modelPath])

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
