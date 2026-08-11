// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { DocsPage } from './DocsPage'

afterEach(cleanup)

function renderDocs(entry = '/docs') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route element={<DocsPage />} path="/docs" />
          <Route element={<div>CAE Workbench</div>} path="/" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('integrated documentation page', () => {
  it('uses Experiment Program by default and normalizes an unknown section', () => {
    renderDocs('/docs?section=unknown')

    expect(screen.getByRole('heading', { name: 'Experiment Program' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Experiment Program의 파일과 책임' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Experiment Program' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('searchbox', { name: '문서 전체 검색' })).toBeInTheDocument()
  })

  it.each([
    ['structure', 'Structure Authoring', 'Structure Source의 책임'],
    ['program', 'Experiment Program', 'Experiment Program의 파일과 책임'],
    ['reference', 'API / CAD Reference', '공개 Source와 import 경계'],
    ['troubleshooting', 'Troubleshooting', '문서가 Ready가 되지 않을 때'],
  ])('opens the %s Manual deep link', (section, navigationLabel, articleTitle) => {
    renderDocs(`/docs?section=${section}`)

    expect(screen.getByRole('button', { name: navigationLabel })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: articleTitle })).toBeInTheDocument()
  })

  it('opens direct section and catalog item links', () => {
    renderDocs('/docs?section=geometry&item=box')

    expect(screen.getByRole('button', { name: 'Geometry Catalog' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Primitives & Operations' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '<box />' })).toBeInTheDocument()
  })

  it('navigates between Manual sections from the sidebar', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.click(screen.getByRole('button', { name: 'API / CAD Reference' }))

    expect(screen.getByRole('heading', { name: 'API / CAD Reference' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'API / CAD Reference' })).toHaveAttribute('aria-current', 'page')
  })

  it('uses the mobile navigation sheet to open a catalog section', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.click(screen.getByRole('button', { name: '문서 메뉴 열기' }))
    const navigation = screen.getByRole('dialog', { name: 'Caemble Documentation' })
    await user.click(within(navigation).getByRole('button', { name: 'Material Catalog' }))

    expect(screen.queryByRole('dialog', { name: 'Caemble Documentation' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Material Parameters' })).toBeInTheDocument()
  })

  it('searches Manual headings and opens their anchored content', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.type(screen.getByRole('searchbox', { name: '문서 전체 검색' }), 'invalid_unit')
    await user.click(
      await screen.findByRole('button', { name: 'Troubleshooting: unit, QuantityKind 또는 Material 오류' }),
    )

    expect(screen.getByRole('heading', { name: 'unit, QuantityKind 또는 Material 오류' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '문서 전체 검색' })).toHaveValue('')
  })

  it.each([
    ['curvedEdgeCylinder', 'Geometry Catalog: curvedEdgeCylinder', 'Primitives & Operations', '<curvedEdgeCylinder />'],
    [
      'electrical.conductivity',
      'Material Catalog: electrical.conductivity',
      'Material Parameters',
      'electrical.conductivity',
    ],
    [
      'electromagnetism.ElectricCurrent',
      'Quantity Catalog: electromagnetism.ElectricCurrent',
      'Physical Quantity Kinds',
      'electromagnetism.ElectricCurrent',
    ],
    [
      'dc-current-density@0.0.0',
      'Physics Catalog: dc-current-density@0.0.0',
      'Simulations & Analysis',
      'dc-current-density',
    ],
  ])(
    'searches the full catalog index for %s and opens its detail',
    async (query, resultName, pageTitle, detailTitle) => {
      const user = userEvent.setup()
      renderDocs()

      await user.type(screen.getByRole('searchbox', { name: '문서 전체 검색' }), query)
      await user.click(await screen.findByRole('button', { name: resultName }))

      expect(screen.getByRole('heading', { name: pageTitle })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: detailTitle })).toBeInTheDocument()
    },
  )
})
