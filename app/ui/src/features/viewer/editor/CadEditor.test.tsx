// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { primitiveAuthoringElements } from '@/lib/cad'
import CadEditor from './CadEditor'
import type { CadEditorAuthoringState } from './CadEditor'

const monacoMocks = vi.hoisted(() => {
  let cursorListener: ((event: { position: { lineNumber: number; column: number } }) => void) | null = null
  let selectionListener: ((event: { selection: ReturnType<typeof makeSelection> }) => void) | null = null
  let content = 'export const Part = () => <box />'
  let position = { lineNumber: 1, column: 1 }
  function offsetAt(next: { lineNumber: number; column: number }) {
    const lines = content.split('\n')
    return lines.slice(0, next.lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + next.column - 1
  }
  function positionAt(offset: number) {
    const before = content.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 }
  }
  function makeSelection(startOffset = 0, endOffset = 0) {
    return {
      getEndPosition: () => positionAt(endOffset),
      getStartPosition: () => positionAt(startOffset),
      isEmpty: () => startOffset === endOffset,
      startOffset,
      endOffset,
    }
  }
  let selection = makeSelection()
  const contentDispose = vi.fn()
  const cursorDispose = vi.fn()
  const selectionDispose = vi.fn()
  const modelDispose = vi.fn()
  const editorDispose = vi.fn()
  const model = {
    dispose: modelDispose,
    getFullModelRange: vi.fn(() => ({ full: true })),
    getOffsetAt: vi.fn(offsetAt),
    getPositionAt: vi.fn(positionAt),
    getValue: vi.fn(() => content),
    getValueInRange: vi.fn((range: ReturnType<typeof makeSelection>) =>
      content.slice(range.startOffset, range.endOffset),
    ),
    onDidChangeContent: vi.fn(() => ({ dispose: contentDispose })),
    setValue: vi.fn((next: string) => {
      content = next
    }),
  }
  const executeEdits = vi.fn((_source: string, edits: { text: string }[]) => {
    content = edits[0]?.text ?? content
    return true
  })
  const editor = {
    dispose: editorDispose,
    executeEdits,
    focus: vi.fn(),
    getModel: vi.fn(() => model),
    getPosition: vi.fn(() => position),
    getSelection: vi.fn(() => selection),
    onDidChangeCursorPosition: vi.fn(
      (listener: (event: { position: { lineNumber: number; column: number } }) => void) => {
        cursorListener = listener
        return { dispose: cursorDispose }
      },
    ),
    onDidChangeCursorSelection: vi.fn((listener: (event: { selection: ReturnType<typeof makeSelection> }) => void) => {
      selectionListener = listener
      return { dispose: selectionDispose }
    }),
    pushUndoStop: vi.fn(),
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    setPosition: vi.fn((next: { lineNumber: number; column: number }) => {
      position = next
      selection = makeSelection(offsetAt(next), offsetAt(next))
    }),
    updateOptions: vi.fn(),
  }
  return {
    contentDispose,
    cursorDispose,
    editorDispose,
    emitCursor(nextPosition: { lineNumber: number; column: number }) {
      position = nextPosition
      cursorListener?.({ position: nextPosition })
    },
    emitSelection(startOffset: number, endOffset: number) {
      selection = makeSelection(startOffset, endOffset)
      selectionListener?.({ selection })
    },
    editor,
    executeEdits,
    loadMonaco: vi.fn(async () => ({
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
      Uri: { parse: vi.fn((value: string) => value) },
      editor: {
        create: vi.fn(() => editor),
        createModel: vi.fn(() => model),
        getModel: vi.fn(() => null),
        setModelMarkers: vi.fn(),
      },
    })),
    model,
    modelDispose,
    reset() {
      content = 'export const Part = () => <box />'
      position = { lineNumber: 1, column: 1 }
      selection = makeSelection()
      cursorListener = null
      selectionListener = null
    },
    selectionDispose,
  }
})

vi.mock('@/lib/cad/authoring', () => ({ loadMonaco: monacoMocks.loadMonaco }))

describe('CadEditor cursor offsets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    monacoMocks.reset()
  })
  afterEach(cleanup)

  it('emits the initial and changed cursor offsets and disposes its listeners', async () => {
    const onCursorOffsetChange = vi.fn()
    const { unmount } = render(
      <CadEditor
        disposeModelOnUnmount
        modelPath="file:///geometry.tsx"
        onChange={vi.fn()}
        onCursorOffsetChange={onCursorOffsetChange}
        value="export const Part = () => <box />"
      />,
    )

    await waitFor(() => expect(onCursorOffsetChange).toHaveBeenCalledWith(0))
    act(() => monacoMocks.emitCursor({ lineNumber: 2, column: 5 }))
    expect(onCursorOffsetChange).toHaveBeenLastCalledWith('export const Part = () => <box />'.length + 5)

    unmount()
    expect(monacoMocks.contentDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.cursorDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.selectionDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.editorDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.modelDispose).toHaveBeenCalledOnce()
  })

  it('publishes selection capability and applies a primitive as one focused undo step', async () => {
    const onAuthoringStateChange = vi.fn<(state: CadEditorAuthoringState | null) => void>()
    render(
      <CadEditor
        modelPath="file:///geometry.tsx"
        onAuthoringStateChange={onAuthoringStateChange}
        onChange={vi.fn()}
        value="export const Part = () => <box />"
      />,
    )

    await waitFor(() =>
      expect(onAuthoringStateChange).toHaveBeenCalledWith(expect.objectContaining({ hasSelection: false })),
    )
    act(() => monacoMocks.emitSelection(0, 6))
    expect(onAuthoringStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ hasSelection: true }))

    const state = onAuthoringStateChange.mock.calls[onAuthoringStateChange.mock.calls.length - 1]?.[0]
    expect(state?.handle.insertPrimitive(primitiveAuthoringElements[0])).toBe(true)
    expect(monacoMocks.executeEdits).toHaveBeenCalledOnce()
    expect(monacoMocks.editor.pushUndoStop).toHaveBeenCalledTimes(2)
    expect(monacoMocks.editor.focus).toHaveBeenCalledOnce()
    expect(monacoMocks.model.getValue()).toContain('<Box\n')
  })

  it('withdraws authoring capability while read-only', async () => {
    const onAuthoringStateChange = vi.fn<(state: CadEditorAuthoringState | null) => void>()
    const { rerender } = render(
      <CadEditor
        modelPath="file:///geometry.tsx"
        onAuthoringStateChange={onAuthoringStateChange}
        onChange={vi.fn()}
        value="export const Part = () => <box />"
      />,
    )
    await waitFor(() => expect(onAuthoringStateChange).toHaveBeenCalledWith(expect.any(Object)))

    rerender(
      <CadEditor
        modelPath="file:///geometry.tsx"
        onAuthoringStateChange={onAuthoringStateChange}
        onChange={vi.fn()}
        readOnly
        value="export const Part = () => <box />"
      />,
    )
    expect(onAuthoringStateChange).toHaveBeenLastCalledWith(null)
  })
})
