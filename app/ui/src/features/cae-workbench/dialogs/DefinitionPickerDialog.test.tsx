// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefinitionPickerDialog } from './DefinitionPickerDialog'

const mocks = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  listExperiments: vi.fn(),
  listSaved: vi.fn(),
}))

vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      getExperiment: mocks.getExperiment,
      listExperiments: mocks.listExperiments,
    },
  }
})

vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      Experiment: { ...actual.dbTables.Experiment, listRows: mocks.listSaved },
    },
  }
})

const official = {
  key: 'dc-uniform-bar',
  title: 'DC Uniform Bar',
  description: 'Official DC example',
  cadApiVersion: 8 as const,
  sourceFormatVersion: 2 as const,
  bundleFormatVersion: 5 as const,
  bundleHash: 'a'.repeat(64),
  concepts: ['DC'],
  relatedSolvers: [{ name: 'dc-current-density', version: '0.1.0' }],
}
const detail = {
  ...official,
  sourceBundle: {
    formatVersion: 5 as const,
    files: {
      'experiment.tsx': 'export default 1',
      'geometry.tsx': 'export const Bar = () => <box />',
      'material.tsx': 'export {}',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'tasks/solveField.tsx': 'export default 1',
    },
    geometrySnapshot: { schemaVersion: 2 as const, entryImports: [], modules: [] },
  },
  verification: { kernelTasks: ['solveField'], recordedData: [], expectations: [] },
}

function Harness({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('Experiment definition picker', () => {
  beforeEach(() => {
    mocks.getExperiment.mockReset()
    mocks.listExperiments.mockReset()
    mocks.listSaved.mockReset()
  })
  afterEach(cleanup)

  it('lets an anonymous user open an official Experiment without querying PostgreSQL', async () => {
    mocks.listExperiments.mockResolvedValue({ items: [official], nextCursor: null, total: 1 })
    mocks.getExperiment.mockResolvedValue(detail)
    const onSelectCatalog = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <DefinitionPickerDialog
        authenticated={false}
        open
        onOpenChange={onOpenChange}
        onSelect={vi.fn()}
        onSelectCatalog={onSelectCatalog}
      />,
      { wrapper: Harness },
    )

    await userEvent.click(await screen.findByRole('button', { name: /DC Uniform Bar/u }))

    await waitFor(() => expect(onSelectCatalog).toHaveBeenCalledWith(detail))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('tab', { name: 'Saved Experiments' })).not.toBeInTheDocument()
    expect(mocks.listSaved).not.toHaveBeenCalled()
  })

  it('keeps Saved Experiments usable when the official catalog is unavailable', async () => {
    mocks.listExperiments.mockRejectedValue(new Error('catalog unavailable'))
    mocks.listSaved.mockResolvedValue({
      total: 1,
      items: [{ id: 7, name: 'Saved Study', description: 'PostgreSQL row' }],
    })
    const onSelect = vi.fn()
    render(
      <DefinitionPickerDialog
        authenticated
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
        onSelectCatalog={vi.fn()}
      />,
      { wrapper: Harness },
    )

    expect(await screen.findByText('공식 카탈로그를 불러오지 못했습니다.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Saved Experiments' }))
    await userEvent.click(await screen.findByRole('button', { name: /Saved Study/u }))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 7, name: 'Saved Study' }))
  })
})
