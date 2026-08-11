// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialListPage } from './MaterialListPage'
import { MaterialManager } from './MaterialManager'

const api = vi.hoisted(() => ({
  deleteMaterial: vi.fn(),
  listMaterials: vi.fn(),
  listNames: vi.fn(),
  upsertMaterial: vi.fn(),
  upsertName: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Material: {
      deleteRows: api.deleteMaterial,
      listRows: api.listMaterials,
      upsertRow: api.upsertMaterial,
    },
    MaterialName: {
      listRows: api.listNames,
      upsertRow: api.upsertName,
    },
  },
  getListRequest: (scope = 'visible') => ({
    filter: {},
    limit: 24,
    offset: 0,
    scope,
    search_text: null,
    selected_ids: [],
    sort: ['updated_at', 'desc'],
    text_filter: {},
  }),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'admin-id', email: 'admin@example.com', is_active: true, roles: ['admin'] },
  }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/materials', element: <MaterialListPage /> },
      { path: '/materials/:materialId', element: <div>Material detail destination</div> },
    ],
    { initialEntries: ['/materials'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  api.listMaterials.mockResolvedValue({
    items: [
      { id: 1, inchi: 'InChI=1S/Cu', color: '#d97706', user_id: null },
      { id: 2, inchi: 'InChI=1S/Fe', user_id: 'admin-id' },
    ],
    total: 2,
  })
  api.listNames.mockResolvedValue({
    items: [
      { id: 11, material_id: 1, name: 'Copper', user_id: null },
      { id: 12, material_id: 1, name: '구리', user_id: null },
      { id: 13, material_id: 2, name: 'Iron', user_id: 'admin-id' },
    ],
    total: 3,
  })
  api.deleteMaterial.mockResolvedValue(undefined)
  api.upsertMaterial.mockResolvedValue([{ id: 42 }])
  api.upsertName.mockResolvedValue([{ id: 99 }])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MaterialListPage', () => {
  it('searches all visible names and InChI and opens the selected detail', async () => {
    const router = renderPage()
    expect(await screen.findByText('Copper')).toBeInTheDocument()
    expect(screen.getByText('#d97706')).toBeInTheDocument()
    expect(screen.getByLabelText('색상 #d97706')).toHaveStyle({ backgroundColor: '#d97706' })
    await userEvent.type(screen.getByRole('textbox', { name: 'Material 검색' }), '구리')
    expect(screen.getByText('Copper')).toBeInTheDocument()
    expect(screen.queryByText('Iron')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByRole('textbox', { name: 'Material 검색' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Material 검색' }), '1S/Fe')
    await userEvent.click(screen.getByText('Iron'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/materials/2'))
  })

  it('shows white in an unset picker while creating the Material with a null color', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Material 추가' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Color palette')).toHaveValue('#ffffff')
    expect(within(dialog).getByLabelText('Color')).toHaveValue('')
    await userEvent.click(within(dialog).getByRole('button', { name: '생성' }))

    await waitFor(() =>
      expect(api.upsertMaterial).toHaveBeenCalledWith([expect.objectContaining({ color: null, user_id: null })]),
    )
  })

  it('defaults admin creation to public and rolls back when the initial name fails', async () => {
    api.upsertName.mockRejectedValueOnce(new Error('duplicate name'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Material 추가' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('InChI'), 'InChI=1S/C')
    fireEvent.change(within(dialog).getByLabelText('Color palette'), { target: { value: '#a1b2c3' } })
    expect(within(dialog).getByLabelText('Color')).toHaveValue('#a1b2c3')
    await userEvent.type(within(dialog).getByLabelText('최초 이름'), 'Carbon')
    await userEvent.click(within(dialog).getByRole('button', { name: '생성' }))

    await waitFor(() => expect(api.deleteMaterial).toHaveBeenCalledWith([42]))
    expect(api.upsertMaterial).toHaveBeenCalledWith([expect.objectContaining({ color: '#a1b2c3', user_id: null })])
    expect(api.upsertName).toHaveBeenCalledWith([
      expect.objectContaining({ material_id: 42, name: 'Carbon', user_id: null }),
    ])
  })

  it('라우터 없이 선택된 Material을 상위 manager에 전달한다', async () => {
    const onMaterialIdChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MaterialManager materialId={null} onMaterialIdChange={onMaterialIdChange} />
      </QueryClientProvider>,
    )

    await userEvent.click(await screen.findByText('Iron'))
    expect(onMaterialIdChange).toHaveBeenCalledWith(2)
  })
})
