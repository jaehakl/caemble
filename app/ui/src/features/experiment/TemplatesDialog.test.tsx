import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TemplatesDialog } from './TemplatesDialog'

const mocks = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  listExperiments: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('@/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/catalog')>()
  return { ...actual, catalogApi: mocks }
})
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => {
    const [experimentName, setExperimentName] = useState('')
    return {
      experiment: experimentName ? {} : null,
      experimentName,
      workspaceSession: experimentName ? 1 : 0,
      experimentDocument: { resultSessionKey: null },
      newExperiment: (...values: unknown[]) => {
        mocks.preview(...values)
        setExperimentName(String(values[1]))
      },
    }
  },
}))
vi.mock('./ExperimentPreview', () => ({
  ExperimentPreview: ({ workbench }: { workbench: { experimentName: string } }) => (
    <output aria-label="3D Geometry Preview">{workbench.experimentName}</output>
  ),
}))

const templates = [
  {
    key: 'fiber',
    namespace: 'caemble',
    repository: 'advanced-shapes',
    version: '1.0.0',
    coordinate: 'caemble:experiment/caemble/advanced-shapes/fiber@1.0.0',
    title: 'Fiber Bundle',
    description: 'Fiber description',
    bundleHash: 'fiber-hash',
    concepts: [],
    relatedSolvers: [
      { name: 'ray-tracing', version: '2.0.0', description: 'Ray tracing' },
      { name: 'fdtd', version: '5.0.0', description: 'FDTD' },
    ],
  },
  {
    key: 'beam',
    namespace: 'caemble',
    repository: 'fea',
    version: '1.0.0',
    coordinate: 'caemble:experiment/caemble/fea/beam@1.0.0',
    title: 'Beam',
    description: 'Beam description',
    bundleHash: 'beam-hash',
    concepts: [],
    relatedSolvers: [{ name: 'structural-mechanics', version: '6.1.0', description: 'Structural mechanics' }],
  },
  {
    key: 'empty',
    namespace: 'caemble',
    repository: 'verified',
    version: '1.0.0',
    coordinate: 'caemble:experiment/caemble/verified/empty@1.0.0',
    title: 'No Solver Template',
    description: 'No solver description',
    bundleHash: 'empty-hash',
    concepts: [],
    relatedSolvers: [],
  },
]

const beamDetail = {
  ...templates[1],
  sourceBundle: { files: { 'experiment.tsx': 'export {}' } },
  calculations: [{ name: 'Stress', description: null, source_code: 'export {}' }],
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } })}
    >
      {children}
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listExperiments.mockImplementation(async ({ q = '', repository }: { q?: string; repository?: string }) => {
    const normalizedQuery = q.toLowerCase()
    const items = templates.filter(
      (item) =>
        (!repository || item.repository === repository) &&
        (!normalizedQuery || `${item.title} ${item.description}`.toLowerCase().includes(normalizedQuery)),
    )
    return { items, nextCursor: null, total: items.length }
  })
  mocks.getExperiment.mockResolvedValue(beamDetail)
})

it('shows Templates with dynamic repository categories and no initial selection', async () => {
  render(<TemplatesDialog user={null} onApply={vi.fn()} onClose={vi.fn()} />, { wrapper })

  expect(screen.getByRole('heading', { name: 'Templates' })).toBeInTheDocument()
  expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Solver', '이름'])
  expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'true')
  expect(await screen.findByRole('button', { name: 'advanced-shapes' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'fea' })).toBeInTheDocument()
  expect(screen.getByText('ray-tracing, fdtd')).toHaveAttribute('title', 'ray-tracing, fdtd')
  expect(screen.getByText('structural-mechanics')).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Fiber Bundle' })).toHaveClass('h-7', 'truncate', 'whitespace-nowrap')
  expect(screen.getByText('Geometry를 확인할 Template을 선택하세요.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '적용' })).toBeDisabled()
  expect(mocks.getExperiment).not.toHaveBeenCalled()
})

it('combines category and text filters and clears the selected preview when filters change', async () => {
  render(<TemplatesDialog user={null} onApply={vi.fn()} onClose={vi.fn()} />, { wrapper })

  fireEvent.click(await screen.findByRole('button', { name: 'Beam' }))
  await waitFor(() =>
    expect(mocks.preview).toHaveBeenCalledWith(
      beamDetail.sourceBundle,
      beamDetail.title,
      beamDetail.description,
      beamDetail.calculations,
    ),
  )
  expect(screen.getByLabelText('3D Geometry Preview')).toHaveTextContent('Beam')
  expect(screen.getByRole('heading', { name: 'Beam' })).toBeInTheDocument()
  expect(screen.getByText('Beam description')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '포함된 Calculations' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Concepts' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '관련 Solvers' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'fea' }))
  expect(screen.getByText('Geometry를 확인할 Template을 선택하세요.')).toBeInTheDocument()
  await waitFor(() =>
    expect(mocks.listExperiments).toHaveBeenCalledWith(
      expect.objectContaining({ q: '', repository: 'fea' }),
      expect.anything(),
    ),
  )

  fireEvent.change(screen.getByLabelText('Template 검색'), { target: { value: 'beam' } })
  await waitFor(() =>
    expect(mocks.listExperiments).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'beam', repository: 'fea' }),
      expect.anything(),
    ),
  )

  fireEvent.click(screen.getByRole('button', { name: '전체' }))
  await waitFor(() =>
    expect(mocks.listExperiments).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'beam', repository: undefined }),
      expect.anything(),
    ),
  )
})

it('previews the selected Template, retries detail errors, and applies only loaded detail', async () => {
  const apply = vi.fn()
  mocks.getExperiment.mockRejectedValueOnce(new Error('detail failed'))
  render(<TemplatesDialog user={null} onApply={apply} onClose={vi.fn()} />, { wrapper })

  fireEvent.click(await screen.findByRole('button', { name: 'Beam' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Template 상세 정보를 불러오지 못했습니다.')
  expect(screen.getByRole('button', { name: '적용' })).toBeDisabled()
  expect(apply).not.toHaveBeenCalled()

  mocks.getExperiment.mockResolvedValueOnce(beamDetail)
  fireEvent.click(screen.getByRole('button', { name: 'Viewer 다시 시도' }))
  await waitFor(() => expect(screen.getByLabelText('3D Geometry Preview')).toHaveTextContent('Beam'))
  fireEvent.click(screen.getByRole('button', { name: '적용' }))
  expect(apply).toHaveBeenCalledWith(beamDetail)
})
