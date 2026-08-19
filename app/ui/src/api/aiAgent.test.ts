// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('./http', () => ({
  API_URL: '/api',
  request: mocks.request,
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body: unknown,
    ) {
      super(message)
    }
  },
}))

import {
  AI_AGENT_PROMPT_TOOL_VERSION,
  aiAgentApi,
  aiAgentApiErrorMessage,
  aiAgentProviderFailureMessage,
  clearAiAgentSession,
  connectAiAgent,
  loadAiAgentSession,
  saveAiAgentSession,
  type AiAgentSessionBinding,
} from './aiAgent'
import { ApiError } from './http'

beforeEach(() => {
  mocks.request.mockReset()
  clearAiAgentSession()
})

describe('AI Agent API transport', () => {
  it('normalizes the provider contract and sends credential mutations through the native API client', async () => {
    mocks.request.mockResolvedValueOnce({
      providers: [
        {
          provider: 'openai',
          displayName: 'OpenAI',
          configured: true,
          credentialVersion: 3,
          updatedAt: '2026-08-19T00:00:00Z',
          models: [
            {
              id: 'gpt-5.6-luna',
              displayName: 'GPT-5.6 Luna',
              reasoningEfforts: ['low', 'high'],
            },
          ],
        },
      ],
    })

    await expect(aiAgentApi.listProviders()).resolves.toEqual([
      {
        id: 'openai',
        label: 'OpenAI',
        configured: true,
        credentialVersion: 3,
        updatedAt: '2026-08-19T00:00:00Z',
        models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', reasoningEfforts: ['low', 'high'] }],
      },
    ])

    mocks.request.mockResolvedValue(undefined)
    await aiAgentApi.saveCredential('openai', 'sk-secret')
    await aiAgentApi.deleteCredential('openai')
    mocks.request.mockResolvedValue({ provider: 'openai', model: 'gpt-5.6-luna', ok: true })
    await expect(aiAgentApi.testCredential('openai')).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      ok: true,
    })
    expect(mocks.request).toHaveBeenNthCalledWith(2, 'put', '/ai/providers/openai/credential', {
      apiKey: 'sk-secret',
    })
    expect(mocks.request).toHaveBeenNthCalledWith(3, 'delete', '/ai/providers/openai/credential')
    expect(mocks.request).toHaveBeenNthCalledWith(4, 'post', '/ai/providers/openai/credential/test')
  })

  it('binds the opaque session envelope to identity, credential, Experiment, permissions and prompt version', () => {
    const binding = sessionBinding()
    saveAiAgentSession(binding, 'sealed-context')
    expect(loadAiAgentSession(binding)).toBe('sealed-context')

    expect(loadAiAgentSession({ ...binding, credentialVersion: 8 })).toBeNull()
    saveAiAgentSession(binding, 'sealed-context')
    expect(loadAiAgentSession({ ...binding, experimentId: 8 })).toBeNull()
    saveAiAgentSession(binding, 'sealed-context')
    expect(loadAiAgentSession({ ...binding, workspaceSession: 8 })).toBeNull()
    saveAiAgentSession(binding, 'sealed-context')
    expect(loadAiAgentSession({ ...binding, permissionFingerprint: 'admin,user' })).toBeNull()
  })

  it('opens the Caemble WS endpoint, serializes client messages and normalizes snake-case server events', async () => {
    const NativeWebSocket = globalThis.WebSocket
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    const onEvent = vi.fn()
    const onClose = vi.fn()
    const connection = connectAiAgent({ onEvent, onClose })
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

    expect(socket.url).toMatch(/^ws:\/\/localhost(?::\d+)?\/api\/ai\/agent\/run$/u)
    socket.open()
    await connection.ready
    connection.send({ type: 'run.cancel', runId: 'run-1' })
    expect(socket.sent).toEqual([JSON.stringify({ type: 'run.cancel', runId: 'run-1' })])

    socket.message({ type: 'assistant.delta', run_id: 'run-1', sequence: 2, delta: '진행 중' })
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({ type: 'message.delta', runId: 'run-1', sequence: 2, delta: '진행 중' }),
    )
    socket.message({
      type: 'workspace.changed',
      run_id: 'run-1',
      sequence: 3,
      staged_revision: 2,
      source_hash: 'source-hash',
      changed_files: ['geometry.tsx'],
    })
    socket.message({
      type: 'context.updated',
      run_id: 'run-1',
      sequence: 4,
      estimated_tokens: 1200,
      included_keys: ['workspace'],
      omitted_keys: ['old-turn'],
      compacted: true,
    })
    socket.message({
      type: 'run.completed',
      run_id: 'run-1',
      sequence: 5,
      staged_revision: 2,
      base_hash: 'base-hash',
      source_hash: 'source-hash',
      geometry_context_version: 'geometry-v1',
      context_usage: { cached_tokens: 400, cache_write_tokens: 100 },
    })
    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith({
        type: 'workspace.changed',
        runId: 'run-1',
        sequence: 3,
        stagedRevision: 2,
        sourceHash: 'source-hash',
        changedFiles: ['geometry.tsx'],
      })
      expect(onEvent).toHaveBeenCalledWith({
        type: 'context.updated',
        runId: 'run-1',
        sequence: 4,
        estimatedTokens: 1200,
        includedKeys: ['workspace'],
        omittedKeys: ['old-turn'],
        compacted: true,
      })
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run.completed',
          runId: 'run-1',
          sequence: 5,
          stagedRevision: 2,
          contextUsage: expect.objectContaining({ cachedTokens: 400, cacheWriteTokens: 100 }),
        }),
      )
    })
    socket.message({
      type: 'run.failed',
      run_id: 'run-1',
      sequence: 6,
      code: 'provider_quota_exceeded',
      message: 'The OpenAI project has no available API quota.',
      retryable: false,
      provider_request_id: 'req_safe123',
    })
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        type: 'run.failed',
        runId: 'run-1',
        sequence: 6,
        code: 'provider_quota_exceeded',
        message: 'The OpenAI project has no available API quota.',
        retryable: false,
        providerRequestId: 'req_safe123',
      }),
    )

    connection.close()
    expect(onClose).toHaveBeenCalledWith(null)
    vi.stubGlobal('WebSocket', NativeWebSocket)
  })

  it('formats actionable Korean provider failures without exposing raw provider text', () => {
    expect(
      aiAgentProviderFailureMessage({
        code: 'provider_quota_exceeded',
        message: 'raw provider message',
        providerRequestId: 'req_safe123',
      }),
    ).toBe('OpenAI API 크레딧 또는 프로젝트 사용 한도가 소진되었습니다. (OpenAI 요청 ID: req_safe123)')
    expect(
      aiAgentApiErrorMessage(
        new ApiError(424, 'raw provider message', {
          detail: {
            code: 'provider_access_denied',
            message: 'raw provider message',
            retryable: false,
            providerRequestId: 'req_safe456',
          },
        }),
        'fallback',
      ),
    ).toBe('해당 OpenAI 프로젝트에서 GPT-5.6 Luna를 사용할 권한이 없습니다. (OpenAI 요청 ID: req_safe456)')
  })
})

function sessionBinding(): AiAgentSessionBinding {
  return {
    userId: 'user-1',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    credentialVersion: 7,
    experimentId: 7,
    workspaceSession: 7,
    permissionFingerprint: 'user',
    promptToolVersion: AI_AGENT_PROMPT_TOOL_VERSION,
  }
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  send(value: string) {
    this.sent.push(value)
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}
