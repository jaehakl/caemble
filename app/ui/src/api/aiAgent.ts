import { API_URL, ApiError, request } from './http'
import type { SavedExperimentRecord } from './types'

export type AiAgentSourceBundle = SavedExperimentRecord['source_bundle']
export const AI_AGENT_WORKSPACE_SCHEMA_VERSION = 'caemble-ai-agent-v5-calculation-source' as const

export type AiAgentExperimentDocument = Readonly<{
  kind: 'experiment'
  sourceBundle: AiAgentSourceBundle
}>
export type AiAgentCalculationDocument = Readonly<{
  kind: 'calculation'
  calculationId: number | null
  experimentId: number
  name: string
  description: string
  sourceCode: string
  editable: boolean
  context: Readonly<Record<string, unknown>>
  referenceExperiment: AiAgentExperimentDocument
}>
export type AiAgentSourceDocument = AiAgentExperimentDocument | AiAgentCalculationDocument

export const AI_AGENT_PROVIDER_QUERY_KEY = ['ai-agent', 'providers'] as const
export const AI_AGENT_PROVIDER = 'openai' as const
export const AI_AGENT_MODEL = 'gpt-5.6-luna' as const
export const AI_AGENT_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type AiAgentReasoningEffort = (typeof AI_AGENT_REASONING_EFFORTS)[number]

export type AiAgentModel = Readonly<{
  id: string
  label: string
  reasoningEfforts: readonly AiAgentReasoningEffort[]
}>

export type AiAgentProvider = Readonly<{
  id: string
  label: string
  configured: boolean
  credentialVersion: string | number | null
  updatedAt: string | null
  models: readonly AiAgentModel[]
}>

export type AiAgentMessage = Readonly<{
  role: 'user' | 'assistant'
  content: string
}>

export type AiAgentConversationMessage = AiAgentMessage &
  Readonly<{
    targetKey: string
    targetLabel: string
  }>

export type AiAgentProvenance = Readonly<{
  kind: string
  label: string
  resourceType?: string
  resourceId?: string | number
  revision?: string
  href?: string
}>

export type AiAgentContextUsage = Readonly<{
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  compacted?: boolean
}>

export type AiAgentProviderFailure = Readonly<{
  code?: string
  message: string
  retryable?: boolean
  providerRequestId?: string
}>

export type AiAgentCredentialTestResult = Readonly<{
  provider: string
  model: string
  ok: true
}>

export type AiAgentApplyRequest = Readonly<{
  runId: string
  finalDocument: AiAgentSourceDocument
  baseHash: string
  referenceHash: string | null
  sourceHash: string
  stagedRevision: number
  workspaceSession: number
  provenance: readonly AiAgentProvenance[]
}>

export type AiAgentApplyResult = Readonly<{
  status: 'applied' | 'conflicted'
  message?: string
  firstChangedFile?: string | null
  changedFiles?: number
}>

export type AiAgentRunStart = Readonly<{
  type: 'run.start'
  request: Readonly<{
    prompt: string
    messages: readonly AiAgentMessage[]
  }>
  provider: string
  model: string
  reasoningEffort: AiAgentReasoningEffort
  workspace: Readonly<{
    schemaVersion: typeof AI_AGENT_WORKSPACE_SCHEMA_VERSION
    experimentId: number | null
    document: AiAgentSourceDocument
    baseHash: string
    referenceHash: string | null
    activeFile: string | null
    workspaceSession: number
  }>
  sessionContextEnvelope?: string
}>

export type AiAgentRunCancel = Readonly<{
  type: 'run.cancel'
  runId: string
}>

type AiAgentEventBase = Readonly<{
  type: string
  runId: string
  sequence: number
}>

export type AiAgentServerEvent =
  | (AiAgentEventBase & Readonly<{ type: 'run.started'; status?: string }>)
  | (AiAgentEventBase & Readonly<{ type: 'run.status'; status: string }>)
  | (AiAgentEventBase & Readonly<{ type: 'message.delta'; delta: string }>)
  | (AiAgentEventBase &
      Readonly<{
        type: 'workspace.changed'
        stagedRevision: number
        sourceHash: string
        changedFiles: readonly string[]
      }>)
  | (AiAgentEventBase &
      Readonly<{
        type: 'context.updated'
        estimatedTokens: number
        includedKeys: readonly string[]
        omittedKeys: readonly string[]
        compacted: boolean
      }>)
  | (AiAgentEventBase &
      Readonly<{
        type: 'tool.started' | 'tool.completed'
        callId: string
        name: string
        summary?: string
      }>)
  | (AiAgentEventBase &
      Readonly<{
        type: 'run.completed'
        message: string
        finalDocument: AiAgentSourceDocument | null
        baseHash: string
        sourceHash: string | null
        stagedRevision: number
        sessionContextEnvelope: string | null
        contextUsage: AiAgentContextUsage | null
        provenance: readonly AiAgentProvenance[]
      }>)
  | (AiAgentEventBase & Readonly<{ type: 'run.failed' }> & AiAgentProviderFailure)
  | (AiAgentEventBase & Readonly<{ type: 'run.cancelled'; message?: string }>)

export const aiAgentApi = Object.freeze({
  async listProviders() {
    const response = await request<{
      providers: readonly Readonly<{
        provider: string
        displayName: string
        configured: boolean
        credentialVersion: number | null
        updatedAt: string | null
        models: readonly Readonly<{
          id: string
          displayName: string
          reasoningEfforts: readonly AiAgentReasoningEffort[]
        }>[]
      }>[]
    }>('get', '/ai/providers')
    return response.providers.map((provider) =>
      Object.freeze({
        id: provider.provider,
        label: provider.displayName,
        configured: provider.configured,
        credentialVersion: provider.credentialVersion,
        updatedAt: provider.updatedAt,
        models: provider.models.map((model) =>
          Object.freeze({
            id: model.id,
            label: model.displayName,
            reasoningEfforts: model.reasoningEfforts,
          }),
        ),
      }),
    )
  },
  async saveCredential(provider: string, apiKey: string) {
    await request<unknown>('put', `/ai/providers/${encodeURIComponent(provider)}/credential`, { apiKey })
  },
  async deleteCredential(provider: string) {
    await request<unknown>('delete', `/ai/providers/${encodeURIComponent(provider)}/credential`)
  },
  async testCredential(provider: string) {
    return request<AiAgentCredentialTestResult>('post', `/ai/providers/${encodeURIComponent(provider)}/credential/test`)
  },
})

export function aiAgentProviderFailureMessage(
  failure: AiAgentProviderFailure,
  fallback = 'AI provider 요청에 실패했습니다.',
) {
  const messages: Record<string, string> = {
    provider_invalid_request: 'OpenAI 요청 형식이 현재 API와 맞지 않습니다. Caemble 서버 업데이트를 확인해 주세요.',
    provider_authentication_failed: '등록한 OpenAI API key가 거부되었습니다. key와 연결된 프로젝트를 확인해 주세요.',
    provider_access_denied: '해당 OpenAI 프로젝트에서 GPT-5.6 Luna를 사용할 권한이 없습니다.',
    provider_quota_exceeded: 'OpenAI API 크레딧 또는 프로젝트 사용 한도가 소진되었습니다.',
    provider_rate_limited: 'OpenAI API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
    provider_timeout: 'OpenAI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
    provider_unavailable: 'OpenAI에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    provider_request_failed: 'OpenAI 요청을 완료하지 못했습니다.',
  }
  const message = (failure.code && messages[failure.code]) || failure.message || fallback
  return failure.providerRequestId ? `${message} (OpenAI 요청 ID: ${failure.providerRequestId})` : message
}

export function aiAgentApiErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return error instanceof Error && error.message ? error.message : fallback
  const body = asRecord(error.body)
  const detail = asRecord(body?.detail)
  if (!detail) return error.message || fallback
  return aiAgentProviderFailureMessage(
    {
      code: stringValue(detail.code) || undefined,
      message: stringValue(detail.message) || error.message || fallback,
      retryable: typeof detail.retryable === 'boolean' ? detail.retryable : undefined,
      providerRequestId: stringValue(detail.providerRequestId, detail.provider_request_id) || undefined,
    },
    fallback,
  )
}

export function aiAgentWebSocketUrl() {
  const url = new URL(`${API_URL}/ai/agent/run`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function connectAiAgent({
  onClose,
  onEvent,
}: {
  onClose: (message: string | null) => void
  onEvent: (event: AiAgentServerEvent) => void | Promise<void>
}) {
  const socket = new WebSocket(aiAgentWebSocketUrl())
  let opened = false
  let settled = false
  let eventQueue = Promise.resolve()
  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      opened = true
      settled = true
      resolve()
    }
    socket.onerror = () => {
      if (!settled) {
        settled = true
        reject(new Error('AI Agent 연결을 열지 못했습니다.'))
      }
    }
  })

  socket.onmessage = ({ data }) => {
    eventQueue = eventQueue
      .then(async () => {
        const event = (typeof data === 'string' ? JSON.parse(data) : data) as AiAgentServerEvent
        await onEvent(event)
      })
      .catch(() => onClose('AI Agent 응답을 처리하지 못했습니다.'))
  }
  socket.onclose = ({ code, reason }) => {
    if (!settled) {
      settled = true
    }
    onClose(opened && code === 1000 ? null : reason || `AI Agent 연결이 종료되었습니다. (${code})`)
  }

  return Object.freeze({
    ready,
    send(message: AiAgentRunStart | AiAgentRunCancel) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('AI Agent 연결이 열려 있지 않습니다.')
      socket.send(JSON.stringify(message))
    },
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000)
    },
  })
}

const SESSION_STORAGE_KEY = 'caemble.ai-helper.agent-session'
const CONVERSATION_STORAGE_KEY = 'caemble.ai-helper.conversation-v1'
const MAX_CONVERSATION_MESSAGES = 200
const MAX_CONVERSATION_BYTES = 1024 * 1024

export type AiAgentSessionBinding = Readonly<{
  userId: string
  provider: string
  model: string
  credentialVersion: string | number | null
  experimentId: number | null
  documentKind: AiAgentSourceDocument['kind']
  documentId: number | null
  schemaVersion: typeof AI_AGENT_WORKSPACE_SCHEMA_VERSION
  referenceHash: string | null
  workspaceSession: number
  permissionFingerprint: string
}>

export function loadAiAgentSession(binding: AiAgentSessionBinding) {
  const serialized = sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!serialized) return null
  const value = JSON.parse(serialized) as Record<string, unknown>
  if (
    value.userId !== binding.userId ||
    value.provider !== binding.provider ||
    value.model !== binding.model ||
    value.credentialVersion !== binding.credentialVersion ||
    value.experimentId !== binding.experimentId ||
    value.documentKind !== binding.documentKind ||
    value.documentId !== binding.documentId ||
    value.schemaVersion !== binding.schemaVersion ||
    value.referenceHash !== binding.referenceHash ||
    value.workspaceSession !== binding.workspaceSession ||
    value.permissionFingerprint !== binding.permissionFingerprint
  ) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
    return null
  }
  return value.envelope as string
}

export function saveAiAgentSession(binding: AiAgentSessionBinding, envelope: string) {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...binding, envelope }))
}

export function clearAiAgentSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY)
}

export function loadAiAgentConversation(userId: string): readonly AiAgentConversationMessage[] {
  const serialized = sessionStorage.getItem(CONVERSATION_STORAGE_KEY)
  if (!serialized) return []
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>
    if (value.version !== 1 || value.userId !== userId || !Array.isArray(value.messages)) {
      sessionStorage.removeItem(CONVERSATION_STORAGE_KEY)
      return []
    }
    const messages = value.messages.filter(
      (message): message is AiAgentConversationMessage =>
        typeof message === 'object' &&
        message !== null &&
        ((message as Record<string, unknown>).role === 'user' ||
          (message as Record<string, unknown>).role === 'assistant') &&
        typeof (message as Record<string, unknown>).content === 'string' &&
        typeof (message as Record<string, unknown>).targetKey === 'string' &&
        typeof (message as Record<string, unknown>).targetLabel === 'string',
    )
    if (messages.length !== value.messages.length) throw new Error('Invalid AI Agent conversation')
    return boundAiAgentConversation(userId, messages)
  } catch {
    sessionStorage.removeItem(CONVERSATION_STORAGE_KEY)
    return []
  }
}

export function saveAiAgentConversation(userId: string, messages: readonly AiAgentConversationMessage[]) {
  const bounded = boundAiAgentConversation(userId, messages)
  sessionStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify({ version: 1, userId, messages: bounded }))
  return bounded
}

export function clearAiAgentConversation() {
  sessionStorage.removeItem(CONVERSATION_STORAGE_KEY)
}

function boundAiAgentConversation(userId: string, messages: readonly AiAgentConversationMessage[]) {
  const bounded = messages.slice(-MAX_CONVERSATION_MESSAGES)
  while (
    bounded.length &&
    new TextEncoder().encode(JSON.stringify({ version: 1, userId, messages: bounded })).byteLength >
      MAX_CONVERSATION_BYTES
  ) {
    bounded.splice(0, bounded[0]?.role === 'user' && bounded[1]?.role === 'assistant' ? 2 : 1)
  }
  return bounded
}

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? ''
}
