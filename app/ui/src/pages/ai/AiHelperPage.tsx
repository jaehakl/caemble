import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  Check,
  CircleStop,
  Database,
  FileCode2,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AI_AGENT_MODEL,
  AI_AGENT_PROVIDER,
  AI_AGENT_PROVIDER_QUERY_KEY,
  AI_AGENT_PROMPT_TOOL_VERSION,
  AI_AGENT_REASONING_EFFORTS,
  aiAgentApi,
  aiAgentProviderFailureMessage,
  clearAiAgentSession,
  connectAiAgent,
  loadAiAgentSession,
  saveAiAgentSession,
  type AiAgentApplyRequest,
  type AiAgentApplyResult,
  type AiAgentContextUsage,
  type AiAgentMessage,
  type AiAgentProvenance,
  type AiAgentReasoningEffort,
  type AiAgentServerEvent,
} from '@/api/aiAgent'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { useAuth } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import { runtimeErrorMessage } from '@/features/runtime/format'
import { assertExperimentSourceBundle } from '@/lib/cad'

type AiHelperMessage = AiAgentMessage & Readonly<{ id: number; streaming: boolean }>
type AiHelperActivity = Readonly<{
  id: string
  label: string
  status: 'running' | 'completed' | 'failed'
  summary?: string
}>

export type AiHelperWorkspaceProps = Readonly<{
  activeExperimentFile: string | null
  activeTab: WorkbenchTabId
  baseHash?: string | null
  geometryContextVersion?: string | null
  onApplyStagedBundle?: (request: AiAgentApplyRequest) => Promise<AiAgentApplyResult>
  onRequestLogin?: () => void
  workbench: CaeWorkbenchState
}>

export function AiHelperWorkspace({
  activeExperimentFile,
  baseHash,
  geometryContextVersion,
  onApplyStagedBundle,
  onRequestLogin,
  workbench,
}: AiHelperWorkspaceProps) {
  const auth = useAuth()
  const providers = useQuery({
    queryKey: AI_AGENT_PROVIDER_QUERY_KEY,
    queryFn: aiAgentApi.listProviders,
    enabled: auth.isAuthenticated,
    staleTime: 30_000,
  })
  const [providerId, setProviderId] = useState<string>(AI_AGENT_PROVIDER)
  const [modelId, setModelId] = useState<string>(AI_AGENT_MODEL)
  const [reasoningEffort, setReasoningEffort] = useState<AiAgentReasoningEffort>('medium')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<readonly AiHelperMessage[]>([])
  const [activity, setActivity] = useState<readonly AiHelperActivity[]>([])
  const [provenance, setProvenance] = useState<readonly AiAgentProvenance[]>([])
  const [contextUsage, setContextUsage] = useState<AiAgentContextUsage | null>(null)
  const [sessionEnvelope, setSessionEnvelope] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('대기 중')
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const connectionRef = useRef<ReturnType<typeof connectAiAgent> | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const assistantIdRef = useRef<number | null>(null)
  const messageIdRef = useRef(0)
  const lastSequenceRef = useRef(-1)
  const runFinishedRef = useRef(true)
  const runWorkspaceIdentityRef = useRef<Readonly<{
    baseHash: string
    geometryContextVersion: string
  }> | null>(null)
  const selectedProvider = providers.data?.find(({ id }) => id === providerId) ?? null
  const selectedModel = selectedProvider?.models.find(({ id }) => id === modelId) ?? null
  const credentialReady = selectedProvider?.configured === true
  const sessionBinding = useMemo(
    () =>
      auth.user && selectedProvider
        ? {
            userId: String(auth.user.id),
            provider: providerId,
            model: modelId,
            credentialVersion: selectedProvider.credentialVersion,
            experimentId: workbench.experimentId,
            workspaceSession: workbench.agentWorkspaceSession,
            permissionFingerprint: [...auth.user.roles].sort().join(','),
            promptToolVersion: AI_AGENT_PROMPT_TOOL_VERSION,
          }
        : null,
    [auth.user, modelId, providerId, selectedProvider, workbench.agentWorkspaceSession, workbench.experimentId],
  )
  const runSessionBindingRef = useRef(sessionBinding)
  const sessionBindingFingerprint = sessionBinding
    ? JSON.stringify(sessionBinding)
    : auth.isAuthenticated && auth.user
      ? `${auth.user.id}:${[...auth.user.roles].sort().join(',')}:unconfigured`
      : null
  const sessionBindingFingerprintRef = useRef(sessionBindingFingerprint)
  const applyHandlerRef = useRef(onApplyStagedBundle)
  applyHandlerRef.current = onApplyStagedBundle

  useEffect(() => {
    const availableProviders = providers.data ?? []
    if (!availableProviders.length) return
    const nextProvider = availableProviders.some(({ id }) => id === providerId) ? providerId : availableProviders[0].id
    const provider = availableProviders.find(({ id }) => id === nextProvider)!
    const nextModel = provider.models.some(({ id }) => id === modelId) ? modelId : (provider.models[0]?.id ?? '')
    setProviderId(nextProvider)
    setModelId(nextModel)
  }, [modelId, providerId, providers.data])

  useEffect(() => {
    if (!selectedModel || selectedModel.reasoningEfforts.includes(reasoningEffort)) return
    setReasoningEffort(
      selectedModel.reasoningEfforts.includes('medium') ? 'medium' : (selectedModel.reasoningEfforts[0] ?? 'medium'),
    )
  }, [reasoningEffort, selectedModel])

  useEffect(() => {
    if (sessionBindingFingerprintRef.current !== sessionBindingFingerprint) {
      sessionBindingFingerprintRef.current = sessionBindingFingerprint
      runFinishedRef.current = true
      connectionRef.current?.close()
      connectionRef.current = null
      activeRunIdRef.current = null
      assistantIdRef.current = null
      runWorkspaceIdentityRef.current = null
      runSessionBindingRef.current = null
      setBusy(false)
      setStatus('대기 중')
      setMessages([])
      setActivity([])
      setProvenance([])
      setContextUsage(null)
      setError(null)
    }
    if (!sessionBinding) {
      if (sessionBindingFingerprint === null) clearAiAgentSession()
      setSessionEnvelope(null)
      return
    }
    setSessionEnvelope(loadAiAgentSession(sessionBinding))
  }, [sessionBinding, sessionBindingFingerprint])

  useEffect(
    () => () => {
      runFinishedRef.current = true
      connectionRef.current?.close()
    },
    [],
  )

  const recentMessages = useMemo(() => boundedRecentMessages(messages), [messages])

  if (auth.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">인증 확인 중</div>
  }
  if (!auth.isAuthenticated || !auth.user) {
    return (
      <WorkbenchSignInPrompt
        description="AI Helper Agent를 사용하려면 Account에서 로그인하세요."
        onSignIn={() => onRequestLogin?.()}
      />
    )
  }

  function nextMessageId() {
    messageIdRef.current += 1
    return messageIdRef.current
  }

  function finishAssistant(content: string) {
    const assistantId = assistantIdRef.current
    if (assistantId === null) return
    setMessages((items) =>
      items.map((message) =>
        message.id === assistantId ? { ...message, content: content || message.content, streaming: false } : message,
      ),
    )
    assistantIdRef.current = null
  }

  function updateActivity(next: AiHelperActivity) {
    setActivity((items) => {
      const index = items.findIndex(({ id }) => id === next.id)
      if (index < 0) return [...items, next]
      return items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item))
    })
  }

  function finishRun(nextStatus: string) {
    runFinishedRef.current = true
    activeRunIdRef.current = null
    setBusy(false)
    setStatus(nextStatus)
    runWorkspaceIdentityRef.current = null
    runSessionBindingRef.current = null
    connectionRef.current?.close()
    connectionRef.current = null
  }

  async function completeRun(event: Extract<AiAgentServerEvent, { type: 'run.completed' }>) {
    finishAssistant(event.message)
    setProvenance(event.provenance)
    setContextUsage(event.contextUsage)
    const runWorkspaceIdentity = runWorkspaceIdentityRef.current
    if (
      !runWorkspaceIdentity ||
      event.baseHash !== runWorkspaceIdentity.baseHash ||
      event.geometryContextVersion !== runWorkspaceIdentity.geometryContextVersion
    ) {
      const message = 'Agent 완료 결과의 Workspace identity가 실행 시작 시점과 일치하지 않습니다.'
      setError(message)
      updateActivity({ id: 'apply', label: '코드 편집기 반영', status: 'failed', summary: message })
      finishRun('Workspace 불일치')
      return
    }
    const runSessionBinding = runSessionBindingRef.current
    const persistSessionEnvelope = () => {
      if (!event.sessionContextEnvelope || !runSessionBinding) return
      saveAiAgentSession(runSessionBinding, event.sessionContextEnvelope)
      setSessionEnvelope(event.sessionContextEnvelope)
    }

    if (!event.finalBundle) {
      try {
        persistSessionEnvelope()
      } catch (nextError) {
        setError(runtimeErrorMessage(nextError, 'AI Agent 세션 문맥을 저장하지 못했습니다.'))
      }
      finishRun('완료')
      return
    }
    if (!event.sourceHash) {
      const message = 'Agent 완료 결과에 source hash가 없어 변경을 자동 반영하지 않았습니다.'
      setError(message)
      updateActivity({ id: 'apply', label: '코드 편집기 반영', status: 'failed', summary: message })
      finishRun('무결성 오류')
      return
    }
    try {
      assertExperimentSourceBundle(event.finalBundle)
      if (!applyHandlerRef.current) throw new Error('Agent 변경을 적용할 Workbench handler가 연결되지 않았습니다.')
      setStatus('코드 편집기에 반영 중')
      const result = await applyHandlerRef.current({
        runId: event.runId,
        finalBundle: event.finalBundle,
        baseHash: runWorkspaceIdentity.baseHash,
        sourceHash: event.sourceHash,
        stagedRevision: event.stagedRevision,
        geometryContextVersion: runWorkspaceIdentity.geometryContextVersion,
        provenance: event.provenance,
      })
      if (result.status === 'conflicted') {
        const message = result.message || 'Agent 실행 중 Experiment가 변경되어 결과를 자동 반영하지 않았습니다.'
        setError(message)
        updateActivity({ id: 'apply', label: '코드 편집기 반영', status: 'failed', summary: message })
        finishRun('충돌')
        return
      }
      try {
        persistSessionEnvelope()
      } catch (nextError) {
        setError(runtimeErrorMessage(nextError, 'AI Agent 세션 문맥을 저장하지 못했습니다.'))
      }
      updateActivity({
        id: 'apply',
        label: '코드 편집기 반영',
        status: 'completed',
        summary: '미검증 AI 변경 · Workbench 확인 중',
      })
      finishRun('미검증 AI 변경 반영됨')
    } catch (nextError) {
      const message = runtimeErrorMessage(nextError, 'Agent 변경을 코드 편집기에 반영하지 못했습니다.')
      setError(message)
      updateActivity({ id: 'apply', label: '코드 편집기 반영', status: 'failed', summary: message })
      finishRun('반영 실패')
    }
  }

  async function handleServerEvent(event: AiAgentServerEvent) {
    if (event.sequence <= lastSequenceRef.current) return
    if (activeRunIdRef.current && event.runId !== activeRunIdRef.current) return
    lastSequenceRef.current = event.sequence
    if (event.type === 'run.started') {
      activeRunIdRef.current = event.runId
      setStatus(event.status || 'Agent 작업 중')
      return
    }
    if (event.type === 'run.status') {
      setStatus(event.status)
      return
    }
    if (event.type === 'message.delta') {
      const assistantId = assistantIdRef.current
      if (assistantId === null) return
      setMessages((items) =>
        items.map((message) =>
          message.id === assistantId ? { ...message, content: message.content + event.delta } : message,
        ),
      )
      return
    }
    if (event.type === 'workspace.changed') {
      updateActivity({
        id: `workspace:${event.stagedRevision}`,
        label: 'staged source 수정',
        status: 'completed',
        summary: `revision ${event.stagedRevision}${event.changedFiles.length ? ` · 파일 ${event.changedFiles.length}개` : ''}`,
      })
      setStatus('staged source 수정됨')
      return
    }
    if (event.type === 'context.updated') {
      setContextUsage((current) => ({
        ...(current ?? {}),
        contextTokens: event.estimatedTokens,
        compacted: event.compacted || current?.compacted,
      }))
      updateActivity({
        id: `context:${event.sequence}`,
        label: 'Agent 컨텍스트 구성',
        status: 'completed',
        summary: `${event.estimatedTokens.toLocaleString()} tokens · 포함 ${event.includedKeys.length} · 제외 ${event.omittedKeys.length}${event.compacted ? ' · 압축됨' : ''}`,
      })
      return
    }
    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      updateActivity({
        id: event.callId,
        label: toolLabel(event.name),
        status: event.type === 'tool.completed' ? 'completed' : 'running',
        summary: event.summary,
      })
      return
    }
    if (event.type === 'run.completed') {
      await completeRun(event)
      return
    }
    if (event.type === 'run.failed') {
      const message = aiAgentProviderFailureMessage(event, event.message)
      finishAssistant(`오류: ${message}`)
      setError(message)
      finishRun('실패')
      return
    }
    finishAssistant('message' in event && event.message ? event.message : '작업을 취소했습니다.')
    finishRun('취소됨')
  }

  async function sendPrompt() {
    const value = prompt.trim()
    const document = workbench.experiment
    if (!baseHash || !geometryContextVersion || !sessionBinding) {
      setError('Workspace context 준비 중입니다. 잠시 후 다시 시도하세요.')
      return
    }
    if (!value || !document || !selectedProvider || !selectedModel) {
      setError(!document ? '먼저 편집할 Experiment를 여세요.' : '질문과 Agent 모델을 확인하세요.')
      return
    }
    if (!credentialReady) {
      setError(`${selectedProvider.label} API key를 Account에 먼저 등록하세요.`)
      return
    }
    const userId = nextMessageId()
    const assistantId = nextMessageId()
    assistantIdRef.current = assistantId
    setMessages((items) => [
      ...items.map((message) => (message.streaming ? { ...message, streaming: false } : message)),
      { id: userId, role: 'user', content: value, streaming: false },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ])
    setPrompt('')
    setActivity([])
    setProvenance([])
    setContextUsage(null)
    setError(null)
    setBusy(true)
    setStatus('연결 중')
    runFinishedRef.current = false
    activeRunIdRef.current = null
    lastSequenceRef.current = -1
    runWorkspaceIdentityRef.current = { baseHash, geometryContextVersion }
    runSessionBindingRef.current = sessionBinding

    const connection = connectAiAgent({
      onEvent: handleServerEvent,
      onClose: (message) => {
        if (runFinishedRef.current || !message) return
        finishAssistant(`오류: ${message}`)
        setError(message)
        finishRun('연결 종료')
      },
    })
    connectionRef.current = connection
    try {
      await connection.ready
      connection.send({
        type: 'run.start',
        request: { prompt: value, messages: recentMessages },
        provider: providerId,
        model: modelId,
        reasoningEffort,
        workspace: {
          experimentId: workbench.experimentId,
          document,
          baseHash,
          geometryContextVersion,
          activeFile:
            activeExperimentFile && activeExperimentFile in document.sourceBundle.files ? activeExperimentFile : null,
          workspaceSession: workbench.agentWorkspaceSession,
        },
        ...(sessionEnvelope ? { sessionContextEnvelope: sessionEnvelope } : {}),
      })
      setStatus('Agent 작업 중')
    } catch (nextError) {
      const message = runtimeErrorMessage(nextError, 'AI Agent 실행을 시작하지 못했습니다.')
      finishAssistant(`오류: ${message}`)
      setError(message)
      finishRun('연결 실패')
    }
  }

  function cancelRun() {
    const runId = activeRunIdRef.current
    if (runId) {
      try {
        connectionRef.current?.send({ type: 'run.cancel', runId })
        setStatus('취소 중')
        return
      } catch {
        // Closing the socket below is the cancellation fallback.
      }
    }
    runFinishedRef.current = true
    connectionRef.current?.close()
    finishAssistant('작업을 취소했습니다.')
    finishRun('취소됨')
  }

  function resetConversation() {
    if (busy) return
    clearAiAgentSession()
    setSessionEnvelope(null)
    setMessages([])
    setActivity([])
    setProvenance([])
    setContextUsage(null)
    setError(null)
    setStatus('대기 중')
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 text-primary" />
          <span className="truncate font-semibold">
            {selectedProvider?.label || 'AI'} · {selectedModel?.label || modelId || '모델 미선택'}
          </span>
          <Badge className={busy ? 'bg-primary text-primary-foreground' : undefined}>{status}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {contextUsage?.contextTokens !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {contextUsage.contextTokens.toLocaleString()} context tokens{contextUsage.compacted ? ' · 압축됨' : ''}
              {contextUsage.cachedTokens ? ` · cache ${contextUsage.cachedTokens.toLocaleString()}` : ''}
            </span>
          ) : null}
          <Button onClick={() => setSettingsOpen(true)} size="sm" type="button" variant="outline">
            <Settings />
            설정
          </Button>
        </div>
      </div>

      {!credentialReady && !providers.isLoading ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-950">
          <span className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {selectedProvider?.label || 'OpenAI'} API key를 등록해야 Agent를 실행할 수 있습니다.
          </span>
          <Button onClick={onRequestLogin} size="sm" type="button" variant="outline">
            Account 열기
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {messages.length ? (
          <div className="space-y-5">
            {messages.map((message) => (
              <div className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'} key={message.id}>
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[82%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm whitespace-pre-wrap text-primary-foreground'
                      : 'max-w-[92%] rounded-2xl rounded-bl-sm border bg-muted/30 px-4 py-3 text-sm'
                  }
                >
                  {message.role === 'assistant' ? (
                    <div className="space-y-3 overflow-hidden break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre]:text-zinc-50 [&_ul]:list-disc [&_ul]:pl-5">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content || (message.streaming ? '…' : '')}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    message.content
                  )}
                </div>
              </div>
            ))}

            {activity.length ? (
              <details className="rounded-lg border bg-muted/20 p-3" open={busy}>
                <summary className="cursor-pointer text-sm font-medium">Agent 작업 {activity.length}개</summary>
                <ul className="mt-3 space-y-2 text-xs">
                  {activity.map((item) => (
                    <li className="flex items-start gap-2" key={item.id}>
                      {item.status === 'running' ? (
                        <LoaderCircle className="mt-0.5 size-3.5 animate-spin text-primary" />
                      ) : item.status === 'completed' ? (
                        <Check className="mt-0.5 size-3.5 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="mt-0.5 size-3.5 text-destructive" />
                      )}
                      <span>
                        {item.label}
                        {item.summary ? <span className="ml-2 text-muted-foreground">{item.summary}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {provenance.length ? (
              <details className="rounded-lg border bg-muted/20 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  사용한 데이터와 카탈로그 {provenance.length}개
                </summary>
                <ul className="mt-3 space-y-2 text-xs">
                  {provenance.map((item, index) => (
                    <li
                      className="flex items-start gap-2"
                      key={`${item.kind}:${item.resourceId ?? item.label}:${index}`}
                    >
                      {item.kind.includes('catalog') ? (
                        <Database className="mt-0.5 size-3.5 text-primary" />
                      ) : (
                        <FileCode2 className="mt-0.5 size-3.5 text-primary" />
                      )}
                      <span>
                        {item.href ? (
                          <a href={item.href} rel="noreferrer" target="_blank" className="text-primary underline">
                            {item.label}
                          </a>
                        ) : (
                          item.label
                        )}
                        {item.resourceType || item.resourceId !== undefined ? (
                          <span className="ml-2 text-muted-foreground">
                            {[item.resourceType, item.resourceId].filter((value) => value !== undefined).join(' #')}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full min-h-52 flex-col items-center justify-center text-center">
            <Bot className="mb-3 size-10 text-muted-foreground" />
            <p className="font-medium">현재 Experiment를 Agent와 함께 편집하세요.</p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Agent는 허용된 데이터와 카탈로그를 검색해 source를 수정하고, 생성된 최종 코드를 미검증 상태로 편집기에
              바로 반영합니다. 결과는 Workbench에서 확인하세요.
            </p>
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t bg-background p-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void sendPrompt()
        }}
      >
        <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>
            질문, 현재 Experiment source, Agent가 조회한 Visible DB·카탈로그 데이터가 선택한 외부 AI 제공자에
            전송됩니다. API key는 Caemble 백엔드에서만 사용됩니다. Caemble은 store=false로 요청하고 대화를 DB에 저장하지
            않지만, 일시적인 prompt cache와 최대 30일의 abuse-monitoring 로그가 provider data controls에 따라 남을 수
            있습니다. Caemble 세션 삭제가 provider의 cache나 로그 삭제를 뜻하지 않습니다.
          </span>
        </div>
        {providers.isError || error ? (
          <p className="mb-2 text-sm text-destructive">
            {error || runtimeErrorMessage(providers.error, 'AI provider 상태를 불러오지 못했습니다.')}
          </p>
        ) : null}
        <textarea
          aria-label="AI Helper 질문"
          className="min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (!busy) void sendPrompt()
          }}
          placeholder="수정할 내용이나 해결할 오류를 입력하세요. Shift+Enter로 줄바꿈"
          value={prompt}
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            disabled={busy || (!messages.length && !sessionEnvelope)}
            onClick={resetConversation}
            type="button"
            variant="outline"
          >
            <RotateCcw />새 대화
          </Button>
          {busy ? (
            <Button onClick={cancelRun} type="button" variant="destructive">
              <CircleStop />
              중지
            </Button>
          ) : (
            <Button
              disabled={
                !credentialReady ||
                providers.isLoading ||
                !selectedModel ||
                !prompt.trim() ||
                !workbench.experiment ||
                !baseHash ||
                !geometryContextVersion
              }
              type="submit"
            >
              <Send />
              전송
            </Button>
          )}
        </div>
      </form>

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>AI Helper Agent 설정</DialogTitle>
            <DialogDescription>
              Provider, Model과 추론 강도만 선택합니다. 나머지 실행 한도는 Caemble이 관리합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm">
              Provider
              <select
                aria-label="AI Provider"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={busy || providers.isLoading}
                onChange={(event) => {
                  clearAiAgentSession()
                  setSessionEnvelope(null)
                  setProviderId(event.target.value)
                }}
                value={providerId}
              >
                {(providers.data ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                    {provider.configured ? '' : ' · key 필요'}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              Model
              <select
                aria-label="AI Model"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={busy || !selectedProvider}
                onChange={(event) => {
                  clearAiAgentSession()
                  setSessionEnvelope(null)
                  setModelId(event.target.value)
                }}
                value={modelId}
              >
                {(selectedProvider?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              Reasoning effort
              <select
                aria-label="Reasoning effort"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={busy}
                onChange={(event) => setReasoningEffort(event.target.value as AiAgentReasoningEffort)}
                value={reasoningEffort}
              >
                {(selectedModel?.reasoningEfforts ?? AI_AGENT_REASONING_EFFORTS).map((effort) => (
                  <option key={effort} value={effort}>
                    {effort.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <p className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
              <Wrench className="mt-0.5 size-3.5 shrink-0" />
              Reasoning을 높이면 복잡한 조회와 편집에 도움이 될 수 있지만 응답 시간과 사용량이 증가합니다. 기본값은
              MEDIUM입니다.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function boundedRecentMessages(messages: readonly AiHelperMessage[]) {
  const selected: AiAgentMessage[] = []
  let bytes = 0
  for (const message of [...messages].reverse()) {
    if (selected.length >= 6 || message.streaming || !message.content) continue
    const nextBytes = new TextEncoder().encode(message.content).byteLength
    if (bytes + nextBytes > 64 * 1024) break
    selected.unshift({ role: message.role, content: message.content })
    bytes += nextBytes
  }
  return Object.freeze(selected)
}

function toolLabel(name: string) {
  const labels: Record<string, string> = {
    get_cad_authoring_reference: 'CAD 문법 상세 조회',
    search_catalog: '카탈로그 검색',
    get_catalog_item: '카탈로그 상세 조회',
    search_visible_data: 'Visible 데이터 검색',
    get_visible_data: 'Visible 데이터 조회',
    read_visible_source: 'Visible source 읽기',
    read_recorded_data_slice: 'RecordedData 구간 읽기',
    list_experiment_files: 'Experiment 파일 목록',
    read_experiment_file: 'staged source 읽기',
    write_experiment_file: 'staged source 수정',
    delete_experiment_task: 'staged Task 삭제',
    read_staged_file: 'staged source 읽기',
    write_staged_file: 'staged source 수정',
    add_staged_task: 'Task 추가',
    delete_staged_task: 'Task 삭제',
  }
  return labels[name] ?? name
}
