// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caembleProgramExamples } from '@/lib/examples'
import { ManualWorkspace } from './DocsPage'

const NativeRequest = globalThis.Request

beforeEach(() => {
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined })
      }
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
afterEach(cleanup)

function renderDocs(onOpenWorkbench = vi.fn()) {
  render(<ManualWorkspace onOpenWorkbench={onOpenWorkbench} />)
  return onOpenWorkbench
}

describe('ManualWorkspace', () => {
  it('opens the Experiment Program guide and returns every verified example to the CAE workbench', async () => {
    const onOpenWorkbench = renderDocs()

    expect(screen.getByRole('heading', { name: /kernel task를 조합해/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Experiment Program' })).toHaveAttribute('aria-pressed', 'true')
    const exampleButtons = screen.getAllByRole('button', { name: /CAE Workbench에서 열기/ })
    expect(exampleButtons).toHaveLength(caembleProgramExamples.length)
    await userEvent.click(exampleButtons[0])
    expect(onOpenWorkbench).toHaveBeenCalledOnce()
    expect(screen.getByText('docs/experiment-program.md')).toBeInTheDocument()
  })

  it('switches the embedded Manual to the CAD reference without changing the URL', async () => {
    renderDocs()

    await userEvent.click(screen.getByRole('button', { name: 'CAD Reference' }))

    expect(screen.getByRole('heading', { name: 'Caemble Help' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CAD Reference' })).toHaveAttribute('aria-pressed', 'true')
  })
})
