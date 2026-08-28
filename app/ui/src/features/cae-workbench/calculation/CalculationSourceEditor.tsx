import { useEffect, useId, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { CALCULATION_MONACO_DECLARATION, type CalculationSourceDiagnostic } from '@/lib/calculation'

const calculationPolicyMarkerOwner = 'caemble-calculation-policy'

function setPolicyMarker(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  diagnostic: CalculationSourceDiagnostic | undefined,
) {
  monaco.editor.setModelMarkers(
    model,
    calculationPolicyMarkerOwner,
    diagnostic
      ? [
          {
            ...diagnostic.range,
            message: diagnostic.message,
            severity: monaco.MarkerSeverity.Error,
            source: 'Calculation policy',
          },
        ]
      : [],
  )
}

export function CalculationSourceEditor({
  diagnostic,
  disabled = false,
  sourceCode,
  onSave,
  onSourceCodeChange,
}: {
  diagnostic?: CalculationSourceDiagnostic
  disabled?: boolean
  sourceCode: string
  onSave: () => void
  onSourceCodeChange: (sourceCode: string) => void
}) {
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null)
  const diagnosticRef = useRef(diagnostic)
  const onSaveRef = useRef(onSave)
  const onSourceCodeChangeRef = useRef(onSourceCodeChange)
  const sourceCodeRef = useRef(sourceCode)
  const disabledRef = useRef(disabled)
  const applyingSourceRef = useRef(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const modelId = useId().replace(/:/gu, '')
  onSaveRef.current = onSave
  onSourceCodeChangeRef.current = onSourceCodeChange
  sourceCodeRef.current = sourceCode
  disabledRef.current = disabled
  diagnosticRef.current = diagnostic

  useEffect(() => {
    const host = editorHostRef.current
    if (!host) return
    let cancelled = false
    let extraLibrary: Monaco.IDisposable | null = null
    let contentSubscription: Monaco.IDisposable | null = null
    void import('@/lib/cad/authoring')
      .then(({ loadMonaco }) => loadMonaco())
      .then((monaco) => {
        if (cancelled) return
        const uri = monaco.Uri.parse(`file:///calculation-${modelId}.js`)
        const model = monaco.editor.createModel(sourceCodeRef.current, 'javascript', uri)
        extraLibrary = monaco.typescript.javascriptDefaults.addExtraLib(
          CALCULATION_MONACO_DECLARATION,
          'file:///calculation-api.d.ts',
        )
        const editor = monaco.editor.create(host, {
          automaticLayout: true,
          fontFamily: 'JetBrains Mono, Consolas, Monaco, monospace',
          fontSize: 13,
          minimap: { enabled: false },
          model,
          padding: { top: 12 },
          readOnly: disabledRef.current,
          scrollBeyondLastLine: false,
          tabSize: 2,
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
        contentSubscription = model.onDidChangeContent(() => {
          if (!applyingSourceRef.current) onSourceCodeChangeRef.current(model.getValue())
        })
        setPolicyMarker(monaco, model, diagnosticRef.current)
        editorRef.current = editor
        monacoRef.current = monaco
        modelRef.current = model
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      contentSubscription?.dispose()
      extraLibrary?.dispose()
      if (monacoRef.current && modelRef.current) setPolicyMarker(monacoRef.current, modelRef.current, undefined)
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      monacoRef.current = null
      modelRef.current = null
    }
  }, [modelId])

  useEffect(() => editorRef.current?.updateOptions({ readOnly: disabled }), [disabled])

  useEffect(() => {
    if (monacoRef.current && modelRef.current) setPolicyMarker(monacoRef.current, modelRef.current, diagnostic)
  }, [diagnostic])

  useEffect(() => {
    const model = modelRef.current
    if (!model || model.getValue() === sourceCode) return
    applyingSourceRef.current = true
    model.setValue(sourceCode)
    applyingSourceRef.current = false
  }, [sourceCode])

  return loadError ? (
    <div className="grid h-full place-items-center p-4 text-center text-sm text-destructive">
      Monaco Editor를 불러오지 못했습니다: {loadError}
    </div>
  ) : (
    <div className="h-full min-h-0 w-full" ref={editorHostRef} />
  )
}
