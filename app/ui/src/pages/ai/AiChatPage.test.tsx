// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChatWorkspace, ChatWorkspace } from './AiChatPage'

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

describe('AiChatWorkspace', () => {
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
            answer: [
              '안녕하세요 **Caemble**',
              '',
              '인라인 `box()` 예시입니다.',
              '',
              '```tsx',
              'const shape = box({ size: [1, 2, 3] })',
              '```',
            ].join('\n'),
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

  it('fills its host with a flat chat layout and keeps settings in the status bar', async () => {
    const user = userEvent.setup()
    const { container } = render(<AiChatWorkspace />)

    const modelName = await screen.findByText('local-llm')
    const workspace = container.firstElementChild
    const settingsButton = screen.getByRole('button', { name: '설정' })

    expect(workspace).toHaveClass('h-full', 'w-full')
    expect(workspace).not.toHaveClass('mx-auto', 'max-w-6xl', 'rounded-xl', 'bg-card', 'shadow-xs')
    expect(container.querySelector('.bg-card')).toBeNull()
    expect(screen.queryByText('Caemble Launcher의 로컬 LLM과 지속적인 streaming 대화를 시작합니다.')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'AI Chat' })).toBeNull()
    expect(modelName.parentElement?.parentElement).toBe(settingsButton.parentElement?.parentElement)

    await user.click(settingsButton)
    expect(screen.getByRole('heading', { name: 'AI Chat 설정' })).toBeVisible()
  })

  it('uses the cookie job endpoint, discovers models, and renders a streamed chat response', async () => {
    const user = userEvent.setup()
    render(<AiChatWorkspace />)

    expect(await screen.findByText('local-llm')).toBeVisible()
    await user.type(screen.getByLabelText('AI 질문'), '인사해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))

    expect(await screen.findByText(/안녕하세요/)).toBeVisible()
    expect(screen.getByText('Caemble')).toBeVisible()
    const inlineCode = screen.getByText('box()')
    const blockCode = screen.getByText('const shape = box({ size: [1, 2, 3] })')
    const markdown = blockCode.closest('pre')?.parentElement
    expect(inlineCode.tagName).toBe('CODE')
    expect(inlineCode.closest('pre')).toBeNull()
    expect(blockCode.tagName).toBe('CODE')
    expect(markdown).toHaveClass(
      '[&_code]:bg-muted',
      '[&_pre_code]:rounded-none',
      '[&_pre_code]:bg-transparent',
      '[&_pre_code]:p-0',
      '[&_pre_code]:text-inherit',
    )
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
    const chatPayload = sdk.runJob.mock.calls.find(([handler]) => handler === 'ai.chat')?.[1]
    expect(chatPayload).not.toHaveProperty('reference_context')
  })

  it('adds an ephemeral reference context only when a reference provider is configured', async () => {
    const user = userEvent.setup()
    const referenceProvider = vi.fn().mockResolvedValue({
      text: '[REFERENCE]\nExperiment 작성 가이드',
      sources: [{ href: '/docs?section=program', title: 'Experiment Authoring' }],
    })
    render(
      <ChatWorkspace
        defaultSystemPrompt="Fixed CAE helper instructions."
        fixedReference
        fixedSystemPrompt
        questionLabel="Helper 질문"
        referenceProvider={referenceProvider}
        showCodeCopy
        title="AI Helper"
      />,
    )

    expect(await screen.findByText('local-llm')).toBeVisible()
    await user.type(screen.getByLabelText('Helper 질문'), 'box를 만들어 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))

    await waitFor(() =>
      expect(sdk.runJob).toHaveBeenCalledWith(
        'ai.chat',
        expect.objectContaining({
          prompt: 'box를 만들어 줘',
          reference_context: '[REFERENCE]\nExperiment 작성 가이드',
          system_prompt: 'Fixed CAE helper instructions.',
        }),
        expect.objectContaining({ autoFinish: false, slaveAppId: 'ai' }),
      ),
    )
    expect(referenceProvider).toHaveBeenCalledWith({
      contextSize: 8192,
      prompt: 'box를 만들어 줘',
      recentUserPrompts: [],
    })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Experiment Authoring' })).toHaveAttribute('href', '/docs?section=program')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(screen.getByRole('button', { name: '코드 복사' }))
    expect(writeText).toHaveBeenCalledWith('const shape = box({ size: [1, 2, 3] })\n')
  })
})
