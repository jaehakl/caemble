import type * as Monaco from 'monaco-editor'

export type CalculationSourceInsertionEditor = Pick<
  Monaco.editor.IStandaloneCodeEditor,
  'executeEdits' | 'focus' | 'getSelection' | 'pushUndoStop' | 'setPosition'
>

export function insertCalculationSourceAtSelection(editor: CalculationSourceInsertionEditor, text: string): boolean {
  const selection = editor.getSelection()
  if (!selection) return false
  editor.pushUndoStop()
  const inserted = editor.executeEdits('experiment-record-insert', [{ forceMoveMarkers: true, range: selection, text }])
  if (!inserted) return false
  editor.setPosition({ lineNumber: selection.startLineNumber, column: selection.startColumn + text.length })
  editor.pushUndoStop()
  editor.focus()
  return true
}
