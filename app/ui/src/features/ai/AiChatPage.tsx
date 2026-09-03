import { GpStationClient, type JobEvent, type JobSession } from '@gpstation/v1-master-js-sdk'
import { Check, Copy, MessageCircle, Send, Settings, Square } from 'lucide-react'
import { isValidElement, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { API_URL } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { runtimeErrorMessage } from '@/features/runtime/format'

const CHAT_TIMEOUT_MS = 600_000

type ChatResponse = {
  model: string
  answer: string
  context_window: number
  remaining_tokens: number
  cache_enabled: boolean
}

type ChatMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
}

type LlmModel = {
  name: string
  provider: 'llama_cpp' | 'openai'
  context_size: number
  top_p: number
}

type LlmModelPayload = Omit<LlmModel, 'provider'> & { provider?: 'llama_cpp' | 'openai' }

export type ChatReferenceContext = Readonly<{
  text: string
  sources: readonly Readonly<{ href: string; title: string }>[]
  truncated?: boolean
}>

export type ChatReferenceRequest = Readonly<{
  contextSize: number
  prompt: string
  recentUserPrompts: readonly string[]
}>

export type AiChatCommand = Readonly<{
  id: number
  type: 'new' | 'end' | 'cancel'
}>

export function AiChatWorkspace({
  command,
  onRequestLogin,
  settingsContainer,
}: {
  command?: AiChatCommand | null
  onRequestLogin?: () => void
  settingsContainer?: Element | null
}) {
  return <ChatWorkspace command={command} onRequestLogin={onRequestLogin} settingsContainer={settingsContainer} />
}

export function ChatWorkspace({
  command,
  defaultSystemPrompt = 'You are a helpful engineering assistant.',
  emptyDescription,
  emptyTitle = '무엇이든 물어보세요.',
  embedded = false,
  fixedReference = false,
  fixedSystemPrompt = false,
  onRequestLogin,
  questionLabel = 'AI 질문',
  questionPlaceholder = '질문을 입력하세요. Shift+Enter로 줄바꿈',
  referenceLabel = '현재 Docs와 Workbench 문맥 자동 첨부',
  referenceProvider,
  settingsContainer,
  showCodeCopy = false,
  title = 'AI Chat',
}: {
  command?: AiChatCommand | null
  defaultSystemPrompt?: string
  emptyDescription?: string
  emptyTitle?: string
  embedded?: boolean
  fixedReference?: boolean
  fixedSystemPrompt?: boolean
  onRequestLogin?: () => void
  questionLabel?: string
  questionPlaceholder?: string
  referenceLabel?: string
  referenceProvider?: (request: ChatReferenceRequest) => ChatReferenceContext | Promise<ChatReferenceContext>
  settingsContainer?: Element | null
  showCodeCopy?: boolean
  title?: string
}) {
  const auth = useAuth()
  const client = useMemo(
    () =>
      new GpStationClient({
        apiBaseUrl: API_URL,
        authMode: 'cookie',
        jobApiPrefix: '/web/jobs',
      }),
    [],
  )
  const [models, setModels] = useState<LlmModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt)
  const [prompt, setPrompt] = useState('')
  const [maxTokens, setMaxTokens] = useState('8192')
  const [temperature, setTemperature] = useState('1.0')
  const [contextSize, setContextSize] = useState('')
  const [topP, setTopP] = useState('')
  const [think, setThink] = useState(false)
  const [thinkingEffort, setThinkingEffort] = useState<'default' | 'low'>('low')
  const [responseFormat, setResponseFormat] = useState<'text' | 'json'>('text')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [context, setContext] = useState<ChatResponse | null>(null)
  const [session, setSession] = useState<JobSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('대기 중')
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [referenceEnabled, setReferenceEnabled] = useState(Boolean(referenceProvider))
  const [referenceContext, setReferenceContext] = useState<ChatReferenceContext | null>(null)
  const messageIdRef = useRef(0)
  const sessionRef = useRef<JobSession | null>(null)
  const activeAssistantIdRef = useRef<number | null>(null)
  const pendingDeltaRef = useRef('')
  const deltaFrameRef = useRef<number | null>(null)
  const lifecycleIdRef = useRef(0)
  const handledCommandIdRef = useRef<number | null>(null)
  const commandHandlerRef = useRef<(type: AiChatCommand['type']) => void>(() => undefined)

  const chatOpen = Boolean(session && !session.closed)
  const selectedModelSettings = models.find((model) => model.name === selectedModel) ?? null
  const selectedModelLabel = selectedModelSettings?.provider === 'openai' ? `OpenAI · ${selectedModel}` : selectedModel
  const openAiThinking = selectedModelSettings?.provider === 'openai' && think

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  commandHandlerRef.current = (type) => {
    if (type === 'cancel') {
      cancelChat()
      return
    }
    void endChat(type === 'new' ? '새 대화' : '대화 종료')
  }

  useEffect(() => {
    if (!command || handledCommandIdRef.current === command.id) return
    handledCommandIdRef.current = command.id
    commandHandlerRef.current(command.type)
  }, [command])

  useEffect(() => {
    if (!auth.isAuthenticated) return
    let cancelled = false
    setModelsLoading(true)
    setModelsError(null)
    void client
      .runJob<Record<string, never>, unknown>('ai.llm.models', {}, { slaveAppId: 'ai', timeoutMs: CHAT_TIMEOUT_MS })
      .then((result) => {
        if (cancelled) return
        if (!isModelList(result.payload)) throw new Error('LLM 모델 목록 응답이 올바르지 않습니다.')
        const payload = result.payload
        const nextModels = payload.models
          .filter(isLlmModel)
          .map((model) => ({ ...model, provider: model.provider ?? ('llama_cpp' as const) }))
        if (!nextModels.length) throw new Error('사용 가능한 LLM 모델이 없습니다.')
        const nextDefault = nextModels.some((model) => model.name === payload.default_model)
          ? payload.default_model
          : nextModels[0].name
        setModels(nextModels)
        setSelectedModel(nextDefault)
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setModelsError(runtimeErrorMessage(nextError, 'LLM 모델 목록을 불러오지 못했습니다.'))
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [auth.isAuthenticated, client])

  useEffect(
    () => () => {
      lifecycleIdRef.current += 1
      const currentSession = sessionRef.current
      sessionRef.current = null
      activeAssistantIdRef.current = null
      pendingDeltaRef.current = ''
      if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current)
      deltaFrameRef.current = null
      if (!currentSession || currentSession.closed) return
      try {
        void Promise.resolve(currentSession.finish({ timeoutMs: CHAT_TIMEOUT_MS })).catch(() => currentSession.close())
      } catch {
        currentSession.close()
      }
    },
    [],
  )

  if (auth.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">인증 확인 중</div>
    )
  }
  if (!auth.isAuthenticated) {
    return (
      <WorkbenchSignInPrompt
        description={`${title}을 사용하려면 Account에서 로그인하세요.`}
        onSignIn={() => onRequestLogin?.()}
      />
    )
  }

  function nextMessageId() {
    messageIdRef.current += 1
    return messageIdRef.current
  }

  function queueDelta(messageId: number, delta: string) {
    if (activeAssistantIdRef.current !== messageId) return
    pendingDeltaRef.current += delta
    if (deltaFrameRef.current !== null) return
    deltaFrameRef.current = window.requestAnimationFrame(() => {
      const buffered = pendingDeltaRef.current
      pendingDeltaRef.current = ''
      deltaFrameRef.current = null
      setMessages((items) =>
        items.map((item) =>
          item.id === messageId && item.streaming ? { ...item, content: item.content + buffered } : item,
        ),
      )
    })
  }

  function handleChatEvent(event: JobEvent, messageId: number) {
    if (event.type !== 'ai.chat.delta' || activeAssistantIdRef.current !== messageId) return
    if (
      typeof event.payload === 'object' &&
      event.payload !== null &&
      'delta' in event.payload &&
      typeof event.payload.delta === 'string'
    ) {
      queueDelta(messageId, event.payload.delta)
    }
  }

  function finishAssistant(messageId: number, content: string) {
    if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current)
    deltaFrameRef.current = null
    pendingDeltaRef.current = ''
    activeAssistantIdRef.current = null
    setMessages((items) => items.map((item) => (item.id === messageId ? { ...item, content, streaming: false } : item)))
  }

  async function sendPrompt() {
    const trimmedPrompt = prompt.trim()
    const currentSession = sessionRef.current && !sessionRef.current.closed ? sessionRef.current : null
    if (!selectedModel || !trimmedPrompt) {
      setError(selectedModel ? '질문을 입력하세요.' : '사용할 LLM 모델을 선택하세요.')
      if (!selectedModel) setSettingsOpen(true)
      return
    }
    if (!currentSession && !systemPrompt.trim()) {
      setError('새 대화에는 System Prompt가 필요합니다.')
      setSettingsOpen(true)
      return
    }

    let generationSettings: Record<string, unknown>
    let effectiveContextSize: number
    try {
      const requestedContextSize = optionalNumber(contextSize, 'Context Size', true)
      effectiveContextSize = requestedContextSize ?? selectedModelSettings?.context_size ?? 8192
      generationSettings = {
        model: selectedModel,
        max_tokens: optionalNumber(maxTokens, 'Max Tokens', true),
        context_size: requestedContextSize,
        ...(openAiThinking
          ? {}
          : {
              temperature: optionalNumber(temperature, 'Temperature'),
              top_p: optionalNumber(topP, 'Top P'),
            }),
        think,
        thinking_effort: thinkingEffort,
        response_format: responseFormat,
      }
    } catch (nextError) {
      setError(runtimeErrorMessage(nextError, '설정 값을 확인하세요.'))
      setSettingsOpen(true)
      return
    }
    const lifecycleId = lifecycleIdRef.current

    let nextReferenceContext: ChatReferenceContext | null = null
    if (referenceProvider && (fixedReference || referenceEnabled)) {
      setStatus('참고자료 준비 중')
      try {
        nextReferenceContext = await referenceProvider({
          contextSize: effectiveContextSize,
          prompt: trimmedPrompt,
          recentUserPrompts: messages
            .filter((message) => message.role === 'user')
            .slice(-2)
            .map((message) => message.content),
        })
      } catch (nextError) {
        if (lifecycleIdRef.current !== lifecycleId) return
        setError(runtimeErrorMessage(nextError, '참고자료를 준비하지 못했습니다.'))
        setStatus('참고자료 오류')
        return
      }
      if (lifecycleIdRef.current !== lifecycleId) return
    }
    setReferenceContext(nextReferenceContext)
    const payload: Record<string, unknown> = {
      ...generationSettings,
      prompt: trimmedPrompt,
      ...(!currentSession ? { system_prompt: systemPrompt.trim() } : {}),
      ...(nextReferenceContext?.text ? { reference_context: nextReferenceContext.text } : {}),
    }

    const userId = nextMessageId()
    const assistantId = nextMessageId()
    activeAssistantIdRef.current = assistantId
    setMessages((items) => [
      ...items.map((item) => (item.streaming ? { ...item, streaming: false } : item)),
      { id: userId, role: 'user', content: trimmedPrompt, streaming: false },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ])
    setPrompt('')
    setBusy(true)
    setError(null)
    setStatus('응답 생성 중')
    try {
      let response: ChatResponse
      if (currentSession) {
        const result = await currentSession.call<Record<string, unknown>, ChatResponse>('ai.chat', payload, {
          timeoutMs: CHAT_TIMEOUT_MS,
          onEvent: (event) => {
            if (lifecycleIdRef.current === lifecycleId) handleChatEvent(event, assistantId)
          },
        })
        if (lifecycleIdRef.current !== lifecycleId) return
        response = result.payload
      } else {
        const result = await client.runJob<Record<string, unknown>, ChatResponse>('ai.chat', payload, {
          slaveAppId: 'ai',
          autoFinish: false,
          timeoutMs: CHAT_TIMEOUT_MS,
          onEvent: (event) => {
            if (lifecycleIdRef.current === lifecycleId) handleChatEvent(event, assistantId)
          },
          onStatus: (nextStatus) => {
            if (lifecycleIdRef.current === lifecycleId) setStatus(nextStatus)
          },
        })
        if (lifecycleIdRef.current !== lifecycleId) {
          if (!result.session.closed) result.session.close()
          return
        }
        sessionRef.current = result.session
        setSession(result.session)
        response = result.payload
      }
      finishAssistant(assistantId, response.answer)
      setContext(response)
      setStatus('대화 연결됨')
    } catch (nextError) {
      if (lifecycleIdRef.current !== lifecycleId) return
      const message = runtimeErrorMessage(nextError, 'AI 응답을 받지 못했습니다.')
      finishAssistant(assistantId, `오류: ${message}`)
      setError(message)
      setStatus('실패')
    } finally {
      if (lifecycleIdRef.current === lifecycleId) setBusy(false)
    }
  }

  async function endChat(nextStatus = '새 대화') {
    const lifecycleId = lifecycleIdRef.current + 1
    lifecycleIdRef.current = lifecycleId
    const currentSession = sessionRef.current
    setBusy(true)
    try {
      if (currentSession && !currentSession.closed) await currentSession.finish({ timeoutMs: CHAT_TIMEOUT_MS })
    } catch {
      currentSession?.close()
    } finally {
      if (lifecycleIdRef.current === lifecycleId) clearConversation(nextStatus)
    }
  }

  function cancelChat() {
    const currentSession = sessionRef.current
    currentSession?.close()
    clearConversation('취소됨')
  }

  function clearConversation(nextStatus: string) {
    lifecycleIdRef.current += 1
    sessionRef.current = null
    activeAssistantIdRef.current = null
    pendingDeltaRef.current = ''
    if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current)
    deltaFrameRef.current = null
    setSession(null)
    setMessages([])
    setContext(null)
    setReferenceContext(null)
    setPrompt('')
    setError(null)
    setStatus(nextStatus)
    setBusy(false)
  }

  const settingsFields = (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-sm">
        Model
        <select
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          disabled={chatOpen || modelsLoading}
          onChange={(event) => setSelectedModel(event.target.value)}
          value={selectedModel}
        >
          {!models.length ? <option value="">{modelsLoading ? '모델 조회 중' : '사용 가능한 모델 없음'}</option> : null}
          {models.map((model) => (
            <option key={model.name} value={model.name}>
              {model.provider === 'openai' ? `OpenAI · ${model.name}` : model.name}
            </option>
          ))}
        </select>
        {selectedModelSettings ? (
          <span className="text-xs text-muted-foreground">
            기본 context {selectedModelSettings.context_size}, top-p {selectedModelSettings.top_p}
          </span>
        ) : null}
      </label>
      {!fixedSystemPrompt ? (
        <label className="grid gap-1.5 text-sm">
          System Prompt
          <textarea
            className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            disabled={chatOpen}
            onChange={(event) => setSystemPrompt(event.target.value)}
            value={systemPrompt}
          />
        </label>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingInput label="Max Tokens" onChange={setMaxTokens} value={maxTokens} />
        <SettingInput disabled={openAiThinking} label="Temperature" onChange={setTemperature} value={temperature} />
        <SettingInput label="Context Size" onChange={setContextSize} value={contextSize} />
        <SettingInput disabled={openAiThinking} label="Top P" onChange={setTopP} value={topP} />
      </div>
      {openAiThinking ? (
        <p className="text-xs text-muted-foreground">
          OpenAI Thinking에서는 Temperature와 Top P에 모델 기본값을 사용합니다.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input checked={think} onChange={(event) => setThink(event.target.checked)} type="checkbox" />
          Thinking
        </label>
        <label className="grid gap-1 text-sm">
          Thinking Effort
          <select
            className="h-9 rounded-md border border-input bg-transparent px-3"
            disabled={!think}
            onChange={(event) => setThinkingEffort(event.target.value as 'default' | 'low')}
            value={thinkingEffort}
          >
            <option value="low">LOW</option>
            <option value="default">DEFAULT</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Response Format
          <select
            className="h-9 rounded-md border border-input bg-transparent px-3"
            onChange={(event) => setResponseFormat(event.target.value as 'text' | 'json')}
            value={responseFormat}
          >
            <option value="text">Text</option>
            <option value="json">JSON</option>
          </select>
        </label>
      </div>
    </div>
  )

  return (
    <div className={`flex h-full min-h-0 w-full flex-col ${embedded ? 'overflow-hidden' : ''}`}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <MessageCircle className="size-4 text-primary" />
          <span className="truncate">{selectedModelLabel || (modelsLoading ? '모델 조회 중' : '모델 미선택')}</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge className={chatOpen ? 'bg-primary text-primary-foreground' : undefined}>{status}</Badge>
          {context ? (
            <span className="text-xs text-muted-foreground">
              {context.context_window - context.remaining_tokens} / {context.context_window} tokens
            </span>
          ) : null}
          {!settingsContainer ? (
            <Button onClick={() => setSettingsOpen(true)} variant="outline">
              <Settings />
              설정
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6">
          {messages.length ? (
            messages.map((message) => (
              <div className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'} key={message.id}>
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[82%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm whitespace-pre-wrap text-primary-foreground'
                      : 'max-w-[90%] rounded-2xl rounded-bl-sm border bg-muted/30 px-4 py-3 text-sm'
                  }
                >
                  {message.role === 'assistant' ? (
                    <div className="space-y-3 overflow-hidden break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre]:text-zinc-50 [&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_table]:block [&_table]:border-collapse [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
                      <ReactMarkdown
                        components={showCodeCopy ? { pre: CopyablePre } : undefined}
                        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
                      >
                        {message.content || (message.streaming ? '…' : '')}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    message.content
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="flex h-full min-h-48 flex-col items-center justify-center text-center">
              <MessageCircle className="mb-3 size-9 text-muted-foreground" />
              <p className="font-medium">{emptyTitle}</p>
              {emptyDescription ? <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p> : null}
            </div>
          )}
        </div>
        <form
          className="border-t bg-background p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void sendPrompt()
          }}
        >
          {referenceProvider ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              {fixedReference ? (
                <span>{referenceLabel}</span>
              ) : (
                <label className="flex items-center gap-2">
                  <input
                    checked={referenceEnabled}
                    disabled={busy}
                    onChange={(event) => setReferenceEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  {referenceLabel}
                </label>
              )}
              {referenceContext ? (
                <details className="max-w-full">
                  <summary className="cursor-pointer">
                    참고자료 {referenceContext.sources.length}개{referenceContext.truncated ? ' · 일부 생략' : ''}
                  </summary>
                  <ul className="mt-2 max-h-28 space-y-1 overflow-auto rounded border bg-muted/30 p-2 text-left">
                    {referenceContext.sources.map((source) => (
                      <li key={`${source.href}:${source.title}`}>
                        <a href={source.href} rel="noreferrer" target="_blank" className="text-primary underline">
                          {source.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
          {error || modelsError ? <p className="mb-2 text-sm text-destructive">{error ?? modelsError}</p> : null}
          <textarea
            aria-label={questionLabel}
            className="min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (!busy && selectedModel) void sendPrompt()
            }}
            placeholder={questionPlaceholder}
            value={prompt}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button disabled={!chatOpen || busy} onClick={() => void endChat()} type="button" variant="outline">
              <Square />새 대화
            </Button>
            <Button disabled={busy || modelsLoading || !selectedModel || !prompt.trim()} type="submit">
              <Send />
              전송
            </Button>
          </div>
        </form>
      </div>

      {settingsContainer ? (
        createPortal(
          <div className="h-full overflow-y-auto p-4">
            <div className="mb-4 space-y-1">
              <h2 className="font-semibold">{title} 설정</h2>
            </div>
            {settingsFields}
          </div>,
          settingsContainer,
        )
      ) : (
        <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{title} 설정</DialogTitle>
              <DialogDescription className="sr-only">{title} 모델 설정</DialogDescription>
            </DialogHeader>
            {settingsFields}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function CopyablePre({ children, ...props }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false)
  const code = markdownText(children)
  return (
    <pre {...props} className="group relative">
      <button
        aria-label="코드 복사"
        className="absolute top-2 right-2 rounded border border-zinc-700 bg-zinc-900/90 p-1.5 text-zinc-200 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
        type="button"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {children}
    </pre>
  )
}

function markdownText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(markdownText).join('')
  if (isValidElement<{ children?: ReactNode }>(value)) return markdownText(value.props.children)
  return ''
}

function SettingInput({
  disabled = false,
  label,
  onChange,
  value,
}: {
  disabled?: boolean
  label: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input disabled={disabled} inputMode="decimal" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  )
}

function optionalNumber(value: string, label: string, integer = false) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} 값이 올바르지 않습니다.`)
  }
  return parsed
}

function isModelList(value: unknown): value is { default_model: string; models: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default_model' in value &&
    typeof value.default_model === 'string' &&
    'models' in value &&
    Array.isArray(value.models)
  )
}

function isLlmModel(value: unknown): value is LlmModelPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'context_size' in value &&
    typeof value.context_size === 'number' &&
    'top_p' in value &&
    typeof value.top_p === 'number' &&
    (!('provider' in value) || value.provider === 'llama_cpp' || value.provider === 'openai')
  )
}
