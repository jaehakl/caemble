// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caembleProgramExamples } from '@/lib/examples'
import { DocsPage } from './DocsPage'

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

function renderDocs(path = '/docs') {
  const router = createMemoryRouter([{ path: '/docs', Component: DocsPage }], {
    initialEntries: [path],
  })
  render(<RouterProvider router={router} />)
  return router
}

describe('DocsPage', () => {
  it('opens the Experiment Program authoring guide by default and links every verified example', () => {
    renderDocs()

    expect(screen.getByRole('heading', { name: /kernel task를 조합해/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Experiment Program' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('link', { name: /Playground에서 열기/ })).toHaveLength(caembleProgramExamples.length)
    expect(screen.getByText('docs/experiment-program.md')).toBeInTheDocument()
  })

  it('keeps the CAD reference behind a deep-linkable section', async () => {
    const router = renderDocs('/docs?section=program')

    await userEvent.click(screen.getByRole('button', { name: 'CAD Reference' }))

    expect(router.state.location.search).toBe('?section=reference')
    expect(screen.getByRole('heading', { name: 'Caemble Help' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CAD Reference' })).toHaveAttribute('aria-pressed', 'true')
  })
})
