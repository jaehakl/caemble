// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialDetail } from './MaterialDetailPage'
import { materialTestCatalog } from './material-test-fixtures'

const api = vi.hoisted(() => ({
  deleteMaterial: vi.fn(),
  listMaterials: vi.fn(),
  listNames: vi.fn(),
  listParameters: vi.fn(),
  listQualifiers: vi.fn(),
  runtimeSlice: vi.fn(),
}))
const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Material: { deleteRows: api.deleteMaterial, listRows: api.listMaterials, upsertRow: vi.fn() },
    MaterialName: { deleteRows: vi.fn(), listRows: api.listNames, upsertRow: vi.fn() },
    MaterialParameter: { deleteRows: vi.fn(), listRows: api.listParameters, upsertRow: vi.fn() },
    MaterialParameterQualifier: { deleteRows: vi.fn(), listRows: api.listQualifiers, upsertRow: vi.fn() },
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

vi.mock('@/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      runtimeSlice: api.runtimeSlice,
    },
  }
})

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-id', email: 'user@example.com', is_active: true, roles: ['user'] },
  }),
}))

vi.mock('sonner', () => ({ toast: notifications }))

function renderDetail({
  command,
  onDeleted = vi.fn(),
}: {
  command: Readonly<{ id: number; type: 'edit' | 'add-name' | 'add-parameter' | 'delete' }>
  onDeleted?: () => void
}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MaterialDetail command={command} materialId={1} onDeleted={onDeleted} />
    </QueryClientProvider>,
  )
  return { ...view, onDeleted, queryClient }
}

beforeEach(() => {
  api.listMaterials.mockResolvedValue({
    items: [{ id: 1, inchi: 'InChI=1S/Cu', color: '#d97706', user_id: 'user-id' }],
    total: 1,
  })
  api.listNames.mockResolvedValue({
    items: [{ id: 10, material_id: 1, name: 'Copper', user_id: 'user-id' }],
    total: 1,
  })
  api.listParameters.mockResolvedValue({ items: [], total: 0 })
  api.listQualifiers.mockResolvedValue({ items: [], total: 0 })
  api.runtimeSlice.mockResolvedValue(materialTestCatalog)
  api.deleteMaterial.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MaterialDetail ribbon commands', () => {
  it('reports permission feedback and does not confirm or delete a Material owned by another user', async () => {
    api.listMaterials.mockResolvedValue({
      items: [{ id: 1, inchi: 'InChI=1S/Cu', color: '#d97706', user_id: 'other-user' }],
      total: 1,
    })
    const confirm = vi.spyOn(window, 'confirm')

    renderDetail({ command: { id: 1, type: 'delete' } })

    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith('이 Material을 편집하거나 삭제할 권한이 없습니다.'),
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(api.deleteMaterial).not.toHaveBeenCalled()
  })

  it('confirms an owned Material Delete command, mutates once, and reports completion', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onDeleted = vi.fn()

    renderDetail({ command: { id: 7, type: 'delete' }, onDeleted })

    expect(await screen.findByRole('heading', { name: 'Copper' })).toBeInTheDocument()
    await waitFor(() => expect(api.deleteMaterial).toHaveBeenCalledWith([1]))
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith(
      '이 Material과 연결된 이름, parameter, qualifier를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.',
    )
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
    expect(notifications.success).toHaveBeenCalledWith('Material을 삭제했습니다.')
  })
})
