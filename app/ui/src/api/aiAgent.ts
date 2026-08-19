import { API_URL, request } from './http'
import type { ExperimentRecord } from './types'

export type AiAgentSourceBundle = ExperimentRecord['source_bundle']
export type AiAgentSourceDocument = Readonly<{
  kind: 'experiment'
  formatVersion: 2
  apiVersion: 7
  sourceBundle: AiAgentSourceBundle
}>

export const AI_AGENT_PROVIDER_QUERY_KEY = ['ai-agent', 'providers'] as const
export const AI_AGENT_PROVIDER = 'openai' as const
export const AI_AGENT_MODEL = 'gpt-5.6-luna' as const
export const AI_AGENT_PROMPT_TOOL_VERSION = 'caemble-ai-agent-v2' as const
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

export type AiAgentValidationRequest = Readonly<{
  runId: string
  callId: string
  stagedBundle: AiAgentSourceBundle
  stagedRevision: number
  sourceHash: string
  geometryContextVersion: string
  signal: AbortSignal
}>

export type AiAgentValidationResult = Readonly<{
  status: 'valid' | 'invalid' | 'unavailable'
  result: unknown
}>

export type AiAgentApplyRequest = Readonly<{
  runId: string
  finalBundle: AiAgentSourceBundle
  baseHash: string
  sourceHash: string | null
  stagedRevision: number
  geometryContextVersion: string
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
    experimentId: number | null
    document: AiAgentSourceDocument
    baseHash: string
    geometryContextVersion: string
    activeFile: string | null
    workspaceSession: number
    validation: Readonly<{
      status: 'valid' | 'invalid' | 'unavailable' | 'stale'
      revision: number
      diagnostics: readonly string[]
    }>
  }>
  sessionContextEnvelope?: string
}>

export type AiAgentClientToolResult = Readonly<{
  type: 'client_tool.result'
  runId: string
  callId: string
  stagedRevision: number
  sourceHash: string
  status: AiAgentValidationResult['status']
  result: unknown
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
        type: 'client_tool.request'
        callId: string
        name: string
        stagedBundle: AiAgentSourceBundle
        stagedRevision: number
        sourceHash: string
        geometryContextVersion: string
      }>)
  | (AiAgentEventBase &
      Readonly<{
        type: 'run.completed'
        message: string
        finalBundle: AiAgentSourceBundle | null
        baseHash: string
        sourceHash: string | null
        stagedRevision: number
        geometryContextVersion: string
        sessionContextEnvelope: string | null
        contextUsage: AiAgentContextUsage | null
        provenance: readonly AiAgentProvenance[]
      }>)
  | (AiAgentEventBase & Readonly<{ type: 'run.failed'; message: string }>)
  | (AiAgentEventBase & Readonly<{ type: 'run.cancelled'; message?: string }>)

export const aiAgentApi = Object.freeze({
  async listProviders() {
    return normalizeProviders(await request<unknown>('get', '/ai/providers'))
  },
  async saveCredential(provider: string, apiKey: string) {
    await request<unknown>('put', `/ai/providers/${encodeURIComponent(provider)}/credential`, { apiKey })
  },
  async deleteCredential(provider: string) {
    await request<unknown>('delete', `/ai/providers/${encodeURIComponent(provider)}/credential`)
  },
})

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
        const event = parseAiAgentServerEvent(typeof data === 'string' ? JSON.parse(data) : data)
        if (event) await onEvent(event)
      })
      .catch(() => onClose('AI Agent 응답 형식이 올바르지 않습니다.'))
  }
  socket.onclose = ({ code, reason }) => {
    if (!settled) {
      settled = true
    }
    onClose(opened && code === 1000 ? null : reason || `AI Agent 연결이 종료되었습니다. (${code})`)
  }

  return Object.freeze({
    ready,
    send(message: AiAgentRunStart | AiAgentClientToolResult | AiAgentRunCancel) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('AI Agent 연결이 열려 있지 않습니다.')
      socket.send(JSON.stringify(message))
    },
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000)
    },
  })
}

const SESSION_STORAGE_KEY = 'caemble.ai-helper.agent-session.v1'
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
const SESSION_MAX_BYTES = 2 * 1024 * 1024

export type AiAgentSessionBinding = Readonly<{
  userId: string
  provider: string
  model: string
  credentialVersion: string | number | null
  experimentId: number | null
  workspaceSession: number
  permissionFingerprint: string
  promptToolVersion: string
}>

export function loadAiAgentSession(binding: AiAgentSessionBinding) {
  const serialized = sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!serialized) return null
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>
    if (
      value.version !== 1 ||
      value.userId !== binding.userId ||
      value.provider !== binding.provider ||
      value.model !== binding.model ||
      value.credentialVersion !== binding.credentialVersion ||
      value.experimentId !== binding.experimentId ||
      value.workspaceSession !== binding.workspaceSession ||
      value.permissionFingerprint !== binding.permissionFingerprint ||
      value.promptToolVersion !== binding.promptToolVersion ||
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > SESSION_MAX_AGE_MS ||
      typeof value.envelope !== 'string' ||
      new TextEncoder().encode(value.envelope).byteLength > SESSION_MAX_BYTES
    ) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }
    return value.envelope
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
    return null
  }
}

export function saveAiAgentSession(binding: AiAgentSessionBinding, envelope: string) {
  if (new TextEncoder().encode(envelope).byteLength > SESSION_MAX_BYTES) {
    throw new Error('AI Agent 세션 문맥이 브라우저 저장 한도를 초과했습니다.')
  }
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 1, ...binding, savedAt: Date.now(), envelope }))
}

export function clearAiAgentSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY)
}

function normalizeProviders(value: unknown): readonly AiAgentProvider[] {
  const record = asRecord(value)
  const items = Array.isArray(value)
    ? value
    : Array.isArray(record?.providers)
      ? record.providers
      : Array.isArray(record?.items)
        ? record.items
        : record
          ? [record]
          : []
  return Object.freeze(items.flatMap((item) => (normalizeProvider(item) ? [normalizeProvider(item)!] : [])))
}

function normalizeProvider(value: unknown): AiAgentProvider | null {
  const record = asRecord(value)
  if (!record) return null
  const id = stringValue(record.id, record.provider, record.name)
  if (!id) return null
  const rawModels = Array.isArray(record.models)
    ? record.models
    : stringValue(record.model)
      ? [stringValue(record.model)]
      : id === AI_AGENT_PROVIDER
        ? [AI_AGENT_MODEL]
        : []
  const models = rawModels.flatMap((model) => {
    if (typeof model === 'string') {
      return [
        Object.freeze({ id: model, label: model, reasoningEfforts: Object.freeze([...AI_AGENT_REASONING_EFFORTS]) }),
      ]
    }
    const modelRecord = asRecord(model)
    const modelId = modelRecord && stringValue(modelRecord.id, modelRecord.model, modelRecord.name)
    if (!modelRecord || !modelId) return []
    const efforts = arrayValue(modelRecord.reasoningEfforts, modelRecord.reasoning_efforts).filter(
      (effort): effort is AiAgentReasoningEffort =>
        typeof effort === 'string' && AI_AGENT_REASONING_EFFORTS.includes(effort as AiAgentReasoningEffort),
    )
    return [
      Object.freeze({
        id: modelId,
        label: stringValue(modelRecord.label, modelRecord.displayName, modelRecord.display_name) || modelId,
        reasoningEfforts: Object.freeze(efforts.length ? efforts : [...AI_AGENT_REASONING_EFFORTS]),
      }),
    ]
  })
  return Object.freeze({
    id,
    label: stringValue(record.label, record.displayName, record.display_name) || (id === 'openai' ? 'OpenAI' : id),
    configured: record.configured === true,
    credentialVersion:
      typeof (record.credentialVersion ?? record.credential_version) === 'string' ||
      typeof (record.credentialVersion ?? record.credential_version) === 'number'
        ? ((record.credentialVersion ?? record.credential_version) as string | number)
        : null,
    updatedAt: stringValue(record.updatedAt, record.updated_at) || null,
    models: Object.freeze(models),
  })
}

function parseAiAgentServerEvent(value: unknown): AiAgentServerEvent | null {
  const record = asRecord(value)
  const type = record && stringValue(record.type)
  const runId = record && stringValue(record.runId, record.run_id)
  const sequence = record && numberValue(record.sequence)
  if (!record || !type || !runId || sequence === null) return null
  const base = { runId, sequence }
  if (type === 'run.started') return { ...base, type, status: stringValue(record.status) || undefined }
  if (type === 'run.status') return { ...base, type, status: stringValue(record.status, record.message) || '작업 중' }
  if (type === 'message.delta' || type === 'assistant.delta') {
    return { ...base, type: 'message.delta', delta: stringValue(record.delta) || '' }
  }
  if (type === 'workspace.changed') {
    const stagedRevision = numberValue(record.stagedRevision, record.staged_revision)
    const sourceHash = stringValue(record.sourceHash, record.source_hash)
    if (stagedRevision === null || !sourceHash) return null
    return {
      ...base,
      type,
      stagedRevision,
      sourceHash,
      changedFiles: Object.freeze(
        arrayValue(record.changedFiles, record.changed_files).filter(
          (path): path is string => typeof path === 'string' && path.length > 0,
        ),
      ),
    }
  }
  if (type === 'context.updated') {
    const estimatedTokens = numberValue(record.estimatedTokens, record.estimated_tokens)
    if (estimatedTokens === null) return null
    return {
      ...base,
      type,
      estimatedTokens,
      includedKeys: Object.freeze(
        arrayValue(record.includedKeys, record.included_keys).filter(
          (key): key is string => typeof key === 'string' && key.length > 0,
        ),
      ),
      omittedKeys: Object.freeze(
        arrayValue(record.omittedKeys, record.omitted_keys).filter(
          (key): key is string => typeof key === 'string' && key.length > 0,
        ),
      ),
      compacted: record.compacted === true,
    }
  }
  if (type === 'tool.started' || type === 'tool.completed') {
    const callId = stringValue(record.callId, record.call_id)
    const name = stringValue(record.name, record.toolName, record.tool_name)
    if (!callId || !name) return null
    return { ...base, type, callId, name, summary: stringValue(record.summary) || undefined }
  }
  if (type === 'client_tool.request') {
    const args = asRecord(record.args)
    const callId = stringValue(record.callId, record.call_id)
    const name = stringValue(record.name)
    const stagedBundle = (args?.stagedBundle ?? args?.staged_bundle) as AiAgentSourceBundle | undefined
    const stagedRevision = numberValue(args?.stagedRevision, args?.staged_revision)
    const sourceHash = stringValue(args?.sourceHash, args?.source_hash)
    const geometryContextVersion = stringValue(args?.geometryContextVersion, args?.geometry_context_version)
    if (!callId || !name || !stagedBundle || stagedRevision === null || !sourceHash || !geometryContextVersion)
      return null
    return { ...base, type, callId, name, stagedBundle, stagedRevision, sourceHash, geometryContextVersion }
  }
  if (type === 'run.completed') {
    const stagedRevision = numberValue(record.stagedRevision, record.staged_revision)
    if (stagedRevision === null) return null
    return {
      ...base,
      type,
      message: stringValue(record.message, record.answer) || '',
      finalBundle: ((record.finalBundle ?? record.final_bundle) as AiAgentSourceBundle | null | undefined) ?? null,
      baseHash: stringValue(record.baseHash, record.base_hash) || '',
      sourceHash: stringValue(record.sourceHash, record.source_hash) || null,
      stagedRevision,
      geometryContextVersion: stringValue(record.geometryContextVersion, record.geometry_context_version) || '',
      sessionContextEnvelope: stringValue(record.sessionContextEnvelope, record.session_context_envelope) || null,
      contextUsage: normalizeContextUsage(record.contextUsage ?? record.context_usage),
      provenance: normalizeProvenance(record.provenance),
    }
  }
  if (type === 'run.failed') return { ...base, type, message: stringValue(record.message, record.error) || '실패' }
  if (type === 'run.cancelled') return { ...base, type, message: stringValue(record.message) || undefined }
  return null
}

function normalizeContextUsage(value: unknown): AiAgentContextUsage | null {
  const record = asRecord(value)
  if (!record) return null
  return Object.freeze({
    inputTokens: numberValue(record.inputTokens, record.input_tokens) ?? undefined,
    outputTokens: numberValue(record.outputTokens, record.output_tokens) ?? undefined,
    contextTokens: numberValue(record.contextTokens, record.context_tokens) ?? undefined,
    cachedTokens: numberValue(record.cachedTokens, record.cached_tokens) ?? undefined,
    cacheWriteTokens: numberValue(record.cacheWriteTokens, record.cache_write_tokens) ?? undefined,
    compacted: typeof record.compacted === 'boolean' ? record.compacted : undefined,
  })
}

function normalizeProvenance(value: unknown): readonly AiAgentProvenance[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze(
    value.flatMap((item) => {
      const record = asRecord(item)
      const kind = record && stringValue(record.kind, record.type)
      const label = record && stringValue(record.label, record.title, record.name)
      if (!record || !kind || !label) return []
      const resourceId = record.resourceId ?? record.resource_id ?? record.id
      return [
        Object.freeze({
          kind,
          label,
          resourceType: stringValue(record.resourceType, record.resource_type) || undefined,
          resourceId: typeof resourceId === 'string' || typeof resourceId === 'number' ? resourceId : undefined,
          revision: stringValue(record.revision, record.hash) || undefined,
          href: stringValue(record.href) || undefined,
        }),
      ]
    }),
  )
}

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? ''
}

function numberValue(...values: unknown[]) {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value)) ?? null
}

function arrayValue(...values: unknown[]) {
  return values.find(Array.isArray) ?? []
}
