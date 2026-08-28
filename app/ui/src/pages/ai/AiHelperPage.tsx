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
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AI_AGENT_MODEL,
  AI_AGENT_PROVIDER,
  AI_AGENT_PROVIDER_QUERY_KEY,
  AI_AGENT_REASONING_EFFORTS,
  AI_AGENT_WORKSPACE_SCHEMA_VERSION,
  aiAgentApi,
  aiAgentProviderFailureMessage,
  clearAiAgentConversation,
  clearAiAgentSession,
  connectAiAgent,
  loadAiAgentConversation,
  loadAiAgentSession,
  saveAiAgentConversation,
  saveAiAgentSession,
  type AiAgentApplyRequest,
  type AiAgentApplyResult,
  type AiAgentConversationMessage,
  type AiAgentContextUsage,
  type AiAgentMessage,
  type AiAgentProvenance,
  type AiAgentReasoningEffort,
  type AiAgentServerEvent,
  type AiAgentSourceDocument,
} from '@/api/aiAgent'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { useAuth } from '@/features/auth/use-auth'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import { runtimeErrorMessage } from '@/features/runtime/format'

type AiHelperMessage = AiAgentConversationMessage & Readonly<{ id: number; streaming: boolean }>
type AiHelperActivity = Readonly<{
  id: string
  label: string
  status: 'running' | 'completed' | 'failed'
  summary?: string
}>

export type AiHelperWorkspaceProps = Readonly<{
  activeExperimentFile: string | null
  activeTab: WorkbenchTabId
  target: Readonly<{
    document: AiAgentSourceDocument
    baseHash: string | null
    referenceHash: string | null
    experimentId: number | null
    key: string
    workspaceSession: number
    label: string
  }> | null
  onApplyStagedDocument?: (request: AiAgentApplyRequest) => Promise<AiAgentApplyResult>
  onRequestLogin?: () => void
}>

export function AiHelperWorkspace({
  activeExperimentFile,
  target,
  onApplyStagedDocument,
  onRequestLogin,
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
  const [reasoningEffort, setReasoningEffort] = useState<AiAgentReasoningEffort>('none')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<readonly AiHelperMessage[]>([])
  const [conversationUserId, setConversationUserId] = useState<string | null>(null)
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
    referenceHash: string | null
    workspaceSession: number
  }> | null>(null)
  const selectedProvider = providers.data?.find(({ id }) => id === providerId) ?? null
  const selectedModel = selectedProvider?.models.find(({ id }) => id === modelId) ?? null
  const credentialReady = selectedProvider?.configured === true
  const targetReady =
    target !== null &&
    target.baseHash !== null &&
    (target.document.kind === 'experiment' || target.referenceHash !== null)
  const sessionBinding = useMemo(
    () =>
      auth.user && selectedProvider && target
        ? {
            userId: String(auth.user.id),
            provider: providerId,
            model: modelId,
            credentialVersion: selectedProvider.credentialVersion,
            experimentId: target.experimentId,
            documentKind: target.document.kind,
            documentId: target.document.kind === 'calculation' ? target.document.calculationId : target.experimentId,
            schemaVersion: AI_AGENT_WORKSPACE_SCHEMA_VERSION,
            referenceHash: target.referenceHash,
            workspaceSession: target.workspaceSession,
            permissionFingerprint: [...auth.user.roles].sort().join(','),
          }
        : null,
    [auth.user, modelId, providerId, selectedProvider, target],
  )
  const runSessionBindingRef = useRef(sessionBinding)
  const sessionBindingFingerprint = sessionBinding
    ? JSON.stringify(sessionBinding)
    : auth.isAuthenticated && auth.user
      ? `${auth.user.id}:${[...auth.user.roles].sort().join(',')}:unconfigured:${target?.key ?? 'none'}`
      : null
  const sessionBindingFingerprintRef = useRef(sessionBindingFingerprint)
  const applyHandlerRef = useRef(onApplyStagedDocument)
  applyHandlerRef.current = onApplyStagedDocument

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
      selectedModel.reasoningEfforts.includes('none') ? 'none' : (selectedModel.reasoningEfforts[0] ?? 'none'),
    )
  }, [reasoningEffort, selectedModel])

  useEffect(() => {
    const previousFingerprint = sessionBindingFingerprintRef.current
    if (previousFingerprint !== sessionBindingFingerprint) {
      sessionBindingFingerprintRef.current = sessionBindingFingerprint
      const interrupted = !runFinishedRef.current
      runFinishedRef.current = true
      connectionRef.current?.close()
      connectionRef.current = null
      activeRunIdRef.current = null
      lastSequenceRef.current = Number.MAX_SAFE_INTEGER
      if (interrupted) finishAssistant('작업 대상 또는 Agent 설정이 변경되어 실행을 취소했습니다.')
      runWorkspaceIdentityRef.current = null
      runSessionBindingRef.current = null
      setBusy(false)
      setStatus('대기 중')
      setActivity([])
      setProvenance([])
      setContextUsage(null)
      setError(null)
      if (!sessionBinding && previousFingerprint?.startsWith('{')) clearAiAgentSession()
    }
    if (!sessionBinding) {
      setSessionEnvelope(null)
      return
    }
    setSessionEnvelope(loadAiAgentSession(sessionBinding))
  }, [sessionBinding, sessionBindingFingerprint])

  useEffect(() => {
    const userId = auth.user ? String(auth.user.id) : null
    if (!userId) {
      if (!auth.isLoading) {
        clearAiAgentConversation()
        clearAiAgentSession()
        if (conversationUserId !== null) {
          setMessages([])
          setConversationUserId(null)
        }
      }
      return
    }
    if (conversationUserId === userId) return
    const stored = loadAiAgentConversation(userId)
    messageIdRef.current = stored.length
    setMessages(stored.map((message, index) => ({ ...message, id: index + 1, streaming: false })))
    setConversationUserId(userId)
  }, [auth.isLoading, auth.user, conversationUserId])

  useEffect(() => {
    const userId = auth.user ? String(auth.user.id) : null
    if (!userId || conversationUserId !== userId) return
    const timeout = window.setTimeout(() => {
      const completed = messages
        .filter((message) => !message.streaming)
        .map(({ role, content, targetKey, targetLabel }) => ({ role, content, targetKey, targetLabel }))
      if (!completed.length) {
        clearAiAgentConversation()
        return
      }
      const stored = saveAiAgentConversation(userId, completed)
      let removeCount = completed.length - stored.length
      if (removeCount <= 0) return
      setMessages((items) =>
        items.filter((message) => {
          if (message.streaming || removeCount <= 0) return true
          removeCount -= 1
          return false
        }),
      )
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [auth.user, conversationUserId, messages])

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
    if (!runWorkspaceIdentity || event.baseHash !== runWorkspaceIdentity.baseHash) {
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

    if (!event.finalDocument) {
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
      if (!applyHandlerRef.current) throw new Error('Agent 변경을 적용할 Workbench handler가 연결되지 않았습니다.')
      setStatus('코드 편집기에 반영 중')
      const result = await applyHandlerRef.current({
        runId: event.runId,
        finalDocument: event.finalDocument,
        baseHash: runWorkspaceIdentity.baseHash,
        referenceHash: runWorkspaceIdentity.referenceHash,
        sourceHash: event.sourceHash,
        stagedRevision: event.stagedRevision,
        workspaceSession: runWorkspaceIdentity.workspaceSession,
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
    const document = target?.document ?? null
    const baseHash = target?.baseHash ?? null
    if (
      !target ||
      !sessionBinding ||
      baseHash === null ||
      (document?.kind === 'calculation' && target.referenceHash === null)
    ) {
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
      { id: userId, role: 'user', content: value, streaming: false, targetKey: target.key, targetLabel: target.label },
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
        targetKey: target.key,
        targetLabel: target.label,
      },
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
    runWorkspaceIdentityRef.current = {
      baseHash,
      referenceHash: target.referenceHash,
      workspaceSession: target.workspaceSession,
    }
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
          schemaVersion: AI_AGENT_WORKSPACE_SCHEMA_VERSION,
          experimentId: target.experimentId,
          document,
          baseHash,
          referenceHash: target.referenceHash,
          activeFile:
            document.kind === 'experiment' &&
            activeExperimentFile &&
            activeExperimentFile in document.sourceBundle.files
              ? activeExperimentFile
              : null,
          workspaceSession: target.workspaceSession,
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
    clearAiAgentConversation()
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
          <Badge className="border bg-background text-foreground">{target?.label ?? '대상 없음'}</Badge>
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
            {messages.map((message, index) => (
              <div className="space-y-3" key={message.id}>
                {index === 0 || messages[index - 1]?.targetKey !== message.targetKey ? (
                  <div className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    <span>{message.targetLabel}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                <div className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
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
            <p className="font-medium">
              {target ? `${target.label} source를 Agent와 함께 편집하세요.` : '편집 대상을 여세요.'}
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
              disabled={!credentialReady || providers.isLoading || !selectedModel || !prompt.trim() || !targetReady}
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
            <DialogDescription className="sr-only">AI Agent 모델 설정</DialogDescription>
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
    const content = `[이전 작업 대상: ${message.targetLabel}]\n${message.content}`
    const nextBytes = new TextEncoder().encode(content).byteLength
    if (bytes + nextBytes > 64 * 1024) break
    selected.unshift({ role: message.role, content })
    bytes += nextBytes
  }
  return Object.freeze(selected)
}

function toolLabel(name: string) {
  const labels: Record<string, string> = {
    get_cad_authoring_reference: 'CAD 문법 상세 조회',
    get_calculation_authoring_reference: 'Calculation 작성 계약 조회',
    search_catalog: '카탈로그 검색',
    get_catalog_item: '카탈로그 상세 조회',
    search_visible_data: 'Visible 데이터 검색',
    get_visible_data: 'Visible 데이터 조회',
    read_visible_source: 'Visible source 읽기',
    read_recorded_data_slice: 'RecordedData 구간 읽기',
    list_experiment_files: 'Experiment 파일 목록',
    read_experiment_file: 'staged source 읽기',
    write_experiment_file: 'staged source 수정',
    delete_experiment_file: 'staged source 삭제',
    read_calculation_source: 'Calculation source 읽기',
    write_calculation_source: 'Calculation source 수정',
  }
  return labels[name] ?? name
}
