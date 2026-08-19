// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountWorkspace } from './AccountPage'

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  startGoogleLogin: vi.fn(),
}))
const auth = vi.hoisted(() => ({ authenticated: true }))
const agentApi = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  listProviders: vi.fn(),
  saveCredential: vi.fn(),
  testCredential: vi.fn(),
}))

vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      AccessKey: api,
    },
    startGoogleLogin: api.startGoogleLogin,
  }
})

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: auth.authenticated,
    isLoading: false,
    user: auth.authenticated
      ? {
          id: 'user-1',
          email: 'designer@example.com',
          display_name: 'Designer',
          picture_url: null,
          is_active: true,
          created_at: '2026-07-21T00:00:00Z',
          updated_at: '2026-07-21T00:00:00Z',
          roles: ['user'],
        }
      : null,
  }),
  useLogout: () => ({ isPending: false, mutate: vi.fn() }),
}))

vi.mock('@/api/aiAgent', async (importActual) => {
  const actual = await importActual<typeof import('@/api/aiAgent')>()
  return {
    ...actual,
    aiAgentApi: agentApi,
  }
})

function token() {
  return {
    id: 'token-1',
    user_id: 'user-1',
    key_type: 'user_api',
    name: 'local-launcher',
    key_prefix: 'csk_example',
    scopes: ['launcher'],
    status: 'active',
    last_used_at: null,
    expires_at: null,
    created_at: '2026-08-07T00:00:00Z',
    revoked_at: null,
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountWorkspace />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('Account access tokens', () => {
  beforeEach(() => {
    auth.authenticated = true
    api.startGoogleLogin.mockReset()
    api.list.mockReset()
    api.list.mockResolvedValue({ total: 1, items: [token()] })
    api.create.mockReset()
    api.create.mockResolvedValue({ access_key: token(), secret: 'csk_secret' })
    api.revoke.mockReset()
    api.revoke.mockResolvedValue({ deleted: 1 })
    agentApi.listProviders.mockReset()
    agentApi.listProviders.mockResolvedValue([
      {
        id: 'openai',
        label: 'OpenAI',
        configured: false,
        credentialVersion: null,
        updatedAt: null,
        models: [{ id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', reasoningEfforts: ['high'] }],
      },
    ])
    agentApi.saveCredential.mockReset()
    agentApi.saveCredential.mockResolvedValue(undefined)
    agentApi.deleteCredential.mockReset()
    agentApi.deleteCredential.mockResolvedValue(undefined)
    agentApi.testCredential.mockReset()
    agentApi.testCredential.mockResolvedValue({ provider: 'openai', model: 'gpt-5.6-luna', ok: true })
  })

  it('starts Google login from Account and returns to the current Workbench URL', async () => {
    auth.authenticated = false
    renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Google로 계속하기' }))
    expect(api.startGoogleLogin).toHaveBeenCalledWith(window.location.href)
  })

  it('creates a purpose-scoped token and reveals its secret once', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('csk_example')).toBeVisible()

    await user.type(screen.getByLabelText('Token 이름'), 'automation')
    await user.selectOptions(screen.getByLabelText('Token 용도'), 'client')
    await user.click(screen.getByRole('button', { name: '생성' }))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        name: 'automation',
        scopes: ['client'],
        expires_at: null,
      }),
    )
    expect(await screen.findByText('csk_secret')).toBeVisible()
    expect(screen.getByText(/다시 표시되지 않습니다/)).toBeVisible()
  })

  it('revokes an active token after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '폐기' }))

    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('token-1'))
  })

  it('registers and removes the current user OpenAI credential without redisplaying it', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('External AI')).toBeVisible()
    expect(screen.getByText(/store=false.*최대 30일/)).toBeVisible()
    await user.type(screen.getByLabelText('Provider API key'), 'sk-user-secret')
    await user.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() => expect(agentApi.saveCredential).toHaveBeenCalledWith('openai', 'sk-user-secret'))
    expect(screen.getByLabelText('Provider API key')).toHaveValue('')
    expect(screen.queryByText('sk-user-secret')).not.toBeInTheDocument()

    agentApi.listProviders.mockResolvedValueOnce([
      {
        id: 'openai',
        label: 'OpenAI',
        configured: true,
        credentialVersion: 2,
        updatedAt: '2026-08-19T00:00:00Z',
        models: [{ id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', reasoningEfforts: ['high'] }],
      },
    ])
    await user.click(screen.getAllByRole('button', { name: '새로고침' })[0])
    expect(await screen.findByText(/Key 원문 숨김/)).toBeVisible()
    expect(screen.getByText(/credential v2/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '연결 테스트' }))
    await waitFor(() => expect(agentApi.testCredential).toHaveBeenCalledWith('openai'))
    expect(await screen.findByText(/openai \/ gpt-5\.6-luna 연결 테스트에 성공/)).toBeVisible()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: '삭제' }))
    await waitFor(() => expect(agentApi.deleteCredential).toHaveBeenCalledWith('openai'))
  })
})
