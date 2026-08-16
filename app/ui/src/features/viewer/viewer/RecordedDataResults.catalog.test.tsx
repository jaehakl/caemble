// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogRuntimeSlice } from '@/api/catalog'
import type { RecordedDataRule } from '@/lib/cad'
import RecordedDataResults from './RecordedDataResults'

const catalog = vi.hoisted(() => ({ runtimeSlice: vi.fn() }))

vi.mock('@/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/catalog')>()
  return { ...actual, catalogApi: { ...actual.catalogApi, runtimeSlice: catalog.runtimeSlice } }
})

const rule: RecordedDataRule = {
  target: ['experiment.geometry.test'],
  label: 'Test result',
  methodId: 'test.record',
  parameters: {},
  result: { dtype: 'float64', unit: '{test}', quantityKind: 'test.Scalar' },
}

const slice: CatalogRuntimeSlice = {
  schemaVersion: 1,
  catalogRevision: 'recorded-test',
  solvers: [],
  quantityKinds: [
    {
      name: 'test.Scalar',
      domain: 'test',
      tensorOrder: 0,
      opaque: true,
      applicableUnits: ['{test}'],
    },
  ],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
}

function renderResults() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RecordedDataResults recordedData={{ 'Test result': { value: 3 } }} rules={[rule]} />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('RecordedDataResults Catalog hydration', () => {
  it('필요한 QuantityKind만 조회할 때까지 동기 tensor 처리를 보류한다', async () => {
    let resolveCatalog!: (value: CatalogRuntimeSlice) => void
    catalog.runtimeSlice.mockReturnValue(new Promise((resolve) => (resolveCatalog = resolve)))

    renderResults()

    expect(screen.getByRole('status')).toHaveTextContent('Recorded Data Catalog를 불러오는 중입니다.')
    expect(screen.queryByLabelText('Recorded scalar value')).not.toBeInTheDocument()
    resolveCatalog(slice)
    expect(await screen.findByLabelText('Recorded scalar value')).toHaveTextContent('3')
    expect(catalog.runtimeSlice).toHaveBeenCalledWith({
      solvers: [],
      quantityKinds: ['test.Scalar'],
      materialParameters: [],
      materialModels: [],
    })
  })

  it('Catalog 오류를 표시하고 동일한 최소 조회를 다시 시도한다', async () => {
    catalog.runtimeSlice.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(slice)
    renderResults()

    expect(await screen.findByRole('alert')).toHaveTextContent('Recorded Data Catalog를 불러오지 못했습니다.')
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByLabelText('Recorded scalar value')).toHaveTextContent('3')
    expect(catalog.runtimeSlice).toHaveBeenCalledTimes(2)
  })
})
