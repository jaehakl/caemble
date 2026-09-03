import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_AGENT_WORKSPACE_SCHEMA_VERSION,
  aiAgentApi,
  connectAiAgent,
  loadAiAgentConversation,
  loadAiAgentSession,
  parseAiAgentServerEvent,
  saveAiAgentSession,
  type AiAgentSessionBinding,
} from './aiAgent'
import { ApiContractError } from './http'

const SESSION_STORAGE_KEY = 'caemble.ai-helper.agent-session'
const CONVERSATION_STORAGE_KEY = 'caemble.ai-helper.conversation-v1'

const sessionBinding: AiAgentSessionBinding = {
  userId: 'user-1',
  provider: 'openai',
  model: 'gpt-5.6-luna',
  credentialVersion: 3,
  experimentId: 7,
  documentKind: 'experiment',
  documentId: null,
  schemaVersion: AI_AGENT_WORKSPACE_SCHEMA_VERSION,
  referenceHash: null,
  workspaceSession: 4,
  permissionFingerprint: 'permission-hash',
}

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('AI Agent external boundaries', () => {
  it('validates server event discriminators and preserves future fields', () => {
    const event = parseAiAgentServerEvent({
      type: 'run.status',
      runId: 'run-1',
      sequence: 1,
      status: 'working',
      futureField: 'kept',
    })

    expect(event).toHaveProperty('futureField', 'kept')
    expect(() => parseAiAgentServerEvent({ type: 'run.status', runId: 'run-1', sequence: 0 })).toThrow()
    expect(() => parseAiAgentServerEvent({ type: 'future.event', runId: 'run-1', sequence: 1 })).toThrow()
  })

  it('validates a completed run document before it reaches the apply handler', () => {
    const completed = {
      type: 'run.completed',
      runId: 'run-1',
      sequence: 2,
      message: 'done',
      finalDocument: {
        kind: 'experiment',
        sourceBundle: { files: { 'experiment.tsx': 'export default null' }, futureBundleField: 'kept' },
        futureDocumentField: 'kept',
      },
      baseHash: 'base-hash',
      sourceHash: 'source-hash',
      stagedRevision: 1,
      sessionContextEnvelope: 'sealed-envelope',
      contextUsage: null,
      provenance: [],
    } as const

    expect(parseAiAgentServerEvent(completed)).toMatchObject({
      finalDocument: {
        futureDocumentField: 'kept',
        sourceBundle: { futureBundleField: 'kept' },
      },
    })
    expect(() =>
      parseAiAgentServerEvent({
        ...completed,
        finalDocument: { kind: 'experiment', sourceBundle: { files: { 'experiment.tsx': 42 } } },
      }),
    ).toThrow()
  })

  it('keeps malformed WebSocket events on the existing failure surface', async () => {
    class FakeWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 3
      static latest: FakeWebSocket | null = null

      readyState = FakeWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(_url: string) {
        FakeWebSocket.latest = this
      }

      open() {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.(new Event('open'))
      }

      emitMessage(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data }))
      }

      send(_data: string) {}

      close() {
        this.readyState = FakeWebSocket.CLOSED
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onClose = vi.fn()
    const onEvent = vi.fn()
    const connection = connectAiAgent({ onClose, onEvent })
    const socket = FakeWebSocket.latest
    if (!socket) throw new Error('AI Agent test socket was not created.')
    socket.open()
    await connection.ready

    socket.emitMessage(JSON.stringify({ type: 'run.status', runId: 'run-1', sequence: 1 }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith('AI Agent 응답을 처리하지 못했습니다.'))

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('loads only a valid session envelope bound to the current user and workspace', () => {
    saveAiAgentSession(sessionBinding, 'sealed-envelope')
    expect(loadAiAgentSession(sessionBinding)).toBe('sealed-envelope')

    expect(loadAiAgentSession({ ...sessionBinding, userId: 'user-2' })).toBeNull()
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()

    sessionStorage.setItem(SESSION_STORAGE_KEY, '{invalid')
    expect(loadAiAgentSession(sessionBinding)).toBeNull()
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()

    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...sessionBinding, envelope: 42 }))
    expect(loadAiAgentSession(sessionBinding)).toBeNull()
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('validates every stored conversation message and preserves future fields', () => {
    sessionStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        messages: [
          {
            role: 'user',
            content: 'hello',
            targetKey: 'experiment:7',
            targetLabel: 'Experiment #7',
            futureField: 'kept',
          },
        ],
      }),
    )

    expect(loadAiAgentConversation('user-1')[0]).toHaveProperty('futureField', 'kept')

    sessionStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify({ version: 1, userId: 'user-1', messages: [{ role: 'user' }] }),
    )
    expect(loadAiAgentConversation('user-1')).toEqual([])
    expect(sessionStorage.getItem(CONVERSATION_STORAGE_KEY)).toBeNull()
  })

  it('rejects a malformed provider response at the HTTP boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              providers: [
                {
                  provider: 'openai',
                  displayName: 'OpenAI',
                  configured: true,
                  credentialVersion: 1,
                  updatedAt: null,
                  models: [{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', reasoningEfforts: ['invalid'] }],
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    await expect(aiAgentApi.listProviders()).rejects.toBeInstanceOf(ApiContractError)
  })
})
