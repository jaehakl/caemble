// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChatPage } from './AiChatPage'

const sdk = vi.hoisted(() => ({
  call: vi.fn(),
  clientOptions: vi.fn(),
  finish: vi.fn(),
  runJob: vi.fn(),
}))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    constructor(options: unknown) {
      sdk.clientOptions(options)
    }

    runJob = sdk.runJob
  },
}))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'user-1', roles: ['user'] } }),
}))

afterEach(cleanup)

describe('AiChatPage', () => {
  beforeEach(() => {
    sdk.call.mockReset()
    sdk.clientOptions.mockReset()
    sdk.finish.mockReset()
    sdk.runJob.mockReset()
    sdk.runJob.mockImplementation(
      async (handler: string, _payload: unknown, options: { onEvent?: (event: unknown) => void }) => {
        if (handler === 'ai.llm.models') {
          return {
            payload: {
              default_model: 'local-llm',
              models: [{ name: 'local-llm', context_size: 8192, top_p: 0.9 }],
            },
            files: [],
          }
        }
        options.onEvent?.({ type: 'ai.chat.delta', payload: { delta: '안녕' } })
        return {
          payload: {
            model: 'local-llm',
            answer: '안녕하세요 **Caemble**',
            context_window: 8192,
            remaining_tokens: 8000,
            cache_enabled: true,
          },
          files: [],
          session: {
            call: sdk.call,
            close: vi.fn(),
            closed: false,
            finish: sdk.finish,
            jobId: 'job-chat',
          },
        }
      },
    )
  })

  it('uses the cookie job endpoint, discovers models, and renders a streamed chat response', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AiChatPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('local-llm')).toBeVisible()
    await user.type(screen.getByLabelText('AI 질문'), '인사해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))

    expect(await screen.findByText(/안녕하세요/)).toBeVisible()
    expect(screen.getByText('Caemble')).toBeVisible()
    expect(sdk.clientOptions).toHaveBeenCalledWith({
      apiBaseUrl: '/api',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    })
    await waitFor(() =>
      expect(sdk.runJob).toHaveBeenCalledWith(
        'ai.chat',
        expect.objectContaining({ model: 'local-llm', prompt: '인사해 줘' }),
        expect.objectContaining({ autoFinish: false, slaveAppId: 'ai' }),
      ),
    )
  })
})
