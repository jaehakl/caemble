// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CadEditor from './CadEditor'

const monacoMocks = vi.hoisted(() => {
  let cursorListener: ((event: { position: { lineNumber: number; column: number } }) => void) | null = null
  const contentDispose = vi.fn()
  const cursorDispose = vi.fn()
  const modelDispose = vi.fn()
  const editorDispose = vi.fn()
  const model = {
    dispose: modelDispose,
    getOffsetAt: vi.fn(({ lineNumber, column }: { lineNumber: number; column: number }) => lineNumber * 100 + column),
    getValue: vi.fn(() => 'export const Part = () => <box />'),
    onDidChangeContent: vi.fn(() => ({ dispose: contentDispose })),
    setValue: vi.fn(),
  }
  const editor = {
    dispose: editorDispose,
    getModel: vi.fn(() => model),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    onDidChangeCursorPosition: vi.fn(
      (listener: (event: { position: { lineNumber: number; column: number } }) => void) => {
        cursorListener = listener
        return { dispose: cursorDispose }
      },
    ),
    updateOptions: vi.fn(),
  }
  return {
    contentDispose,
    cursorDispose,
    editorDispose,
    emitCursor(position: { lineNumber: number; column: number }) {
      cursorListener?.({ position })
    },
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
  }
})

vi.mock('@/lib/cad/authoring', () => ({ loadMonaco: monacoMocks.loadMonaco }))

describe('CadEditor cursor offsets', () => {
  beforeEach(() => vi.clearAllMocks())
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

    await waitFor(() => expect(onCursorOffsetChange).toHaveBeenCalledWith(101))
    act(() => monacoMocks.emitCursor({ lineNumber: 2, column: 5 }))
    expect(onCursorOffsetChange).toHaveBeenLastCalledWith(205)

    unmount()
    expect(monacoMocks.contentDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.cursorDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.editorDispose).toHaveBeenCalledOnce()
    expect(monacoMocks.modelDispose).toHaveBeenCalledOnce()
  })
})
