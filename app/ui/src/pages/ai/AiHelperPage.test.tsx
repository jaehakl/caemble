// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { createCadSourceDocument, createExperimentSourceBundle } from '@/lib/cad'
import { AiHelperWorkspace } from './AiHelperPage'

const mocks = vi.hoisted(() => ({
  callbacks: null as null | {
    onClose: (message: string | null) => void
    onEvent: (event: unknown) => void | Promise<void>
  },
  clearSession: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  listProviders: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-1', roles: ['user'] },
  }),
}))

vi.mock('@/api/aiAgent', async (importActual) => {
  const actual = await importActual<typeof import('@/api/aiAgent')>()
  return {
    ...actual,
    aiAgentApi: { ...actual.aiAgentApi, listProviders: mocks.listProviders },
    clearAiAgentSession: mocks.clearSession,
    loadAiAgentSession: mocks.loadSession,
    saveAiAgentSession: mocks.saveSession,
    connectAiAgent: mocks.connect,
  }
})

afterEach(cleanup)

describe('AiHelperWorkspace Agent transport', () => {
  beforeEach(() => {
    mocks.callbacks = null
    mocks.clearSession.mockReset()
    mocks.close.mockReset()
    mocks.send.mockReset()
    mocks.listProviders.mockReset()
    mocks.listProviders.mockResolvedValue([provider(true)])
    mocks.loadSession.mockReset()
    mocks.loadSession.mockReturnValue('sealed-before')
    mocks.saveSession.mockReset()
    mocks.connect.mockReset()
    mocks.connect.mockImplementation((callbacks) => {
      mocks.callbacks = callbacks
      return { ready: Promise.resolve(), send: mocks.send, close: mocks.close }
    })
  })

  it('shows only provider, model and reasoning settings with the external-data privacy notice', async () => {
    const user = userEvent.setup()
    renderWorkspace()

    expect(await screen.findByText('OpenAI · gpt-5.6-luna')).toBeVisible()
    expect(screen.getByText(/Visible DB·카탈로그 데이터와 컴파일 결과/)).toBeVisible()
    expect(screen.getByText(/store=false.*최대 30일/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '설정' }))

    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(screen.getByLabelText('AI Provider')).toHaveValue('openai')
    expect(screen.getByLabelText('AI Model')).toHaveValue('gpt-5.6-luna')
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('high')
    expect(screen.queryByText('Temperature')).not.toBeInTheDocument()
    expect(screen.queryByText('Top P')).not.toBeInTheDocument()
  })

  it('shows an actionable provider failure instead of the raw OpenAI error', async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), '연결을 확인해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    await emit({ type: 'run.started', runId: 'run-failed', sequence: 0 })
    await emit({
      type: 'run.failed',
      runId: 'run-failed',
      sequence: 1,
      code: 'provider_access_denied',
      message: 'raw provider error',
      retryable: false,
      providerRequestId: 'req_safe123',
    })

    expect(await screen.findAllByText(/GPT-5\.6 Luna를 사용할 권한이 없습니다.*req_safe123/)).toHaveLength(2)
    expect(screen.queryByText('raw provider error')).not.toBeInTheDocument()
  })

  it('runs the WS tool loop, validates staged code, persists only the sealed envelope and applies the final bundle', async () => {
    const user = userEvent.setup()
    const validation = vi.fn().mockResolvedValue({
      status: 'valid',
      result: {
        status: 'valid',
        sourceHash: 'staged-hash',
        requestedSourceHash: 'staged-hash',
        stagedRevision: 3,
        contextVersion: 'geometry-v1',
        diagnostics: [],
      },
    })
    const applyBundle = vi.fn().mockResolvedValue({ status: 'applied' })
    const { bundle } = renderWorkspace({ onApplyStagedBundle: applyBundle, onValidateStagedBundle: validation })

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), '카탈로그를 확인하고 열 해석 Task를 고쳐 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'run.start',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        request: { prompt: '카탈로그를 확인하고 열 해석 Task를 고쳐 줘', messages: [] },
        workspace: expect.objectContaining({
          experimentId: 7,
          document: expect.objectContaining({ kind: 'experiment' }),
          baseHash: 'base-hash',
          geometryContextVersion: 'geometry-v1',
          activeFile: 'tasks/thermal.tsx',
          workspaceSession: 11,
          validation: { status: 'valid', revision: 2, diagnostics: expect.any(Array) },
        }),
        sessionContextEnvelope: 'sealed-before',
      }),
    )
    const runStart = mocks.send.mock.calls[0][0] as {
      workspace: { validation: { diagnostics: string[] } }
    }
    expect(runStart.workspace.validation.diagnostics).toHaveLength(20)
    expect(
      runStart.workspace.validation.diagnostics.every(
        (diagnostic) => new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength <= 1_024,
      ),
    ).toBe(true)

    await emit({ type: 'run.started', runId: 'run-1', sequence: 0, status: '검색 중' })
    await emit({
      type: 'context.updated',
      runId: 'run-1',
      sequence: 1,
      estimatedTokens: 900,
      includedKeys: ['workspace', 'request'],
      omittedKeys: ['old-turn'],
      compacted: false,
    })
    await emit({
      type: 'tool.started',
      runId: 'run-1',
      sequence: 2,
      callId: 'catalog-1',
      name: 'search_catalog',
    })
    await emit({
      type: 'workspace.changed',
      runId: 'run-1',
      sequence: 3,
      stagedRevision: 3,
      sourceHash: 'staged-hash',
      changedFiles: ['tasks/thermal.tsx'],
    })
    await emit({
      type: 'client_tool.request',
      runId: 'run-1',
      sequence: 4,
      callId: 'compile-1',
      name: 'validate_workspace',
      stagedBundle: bundle,
      stagedRevision: 3,
      sourceHash: 'staged-hash',
      geometryContextVersion: 'geometry-v1',
    })

    expect(validation).toHaveBeenCalledWith({
      runId: 'run-1',
      callId: 'compile-1',
      stagedBundle: bundle,
      stagedRevision: 3,
      sourceHash: 'staged-hash',
      geometryContextVersion: 'geometry-v1',
      signal: expect.any(AbortSignal),
    })
    expect(mocks.send).toHaveBeenLastCalledWith({
      type: 'client_tool.result',
      runId: 'run-1',
      callId: 'compile-1',
      stagedRevision: 3,
      sourceHash: 'staged-hash',
      status: 'valid',
      result: {
        status: 'valid',
        sourceHash: 'staged-hash',
        requestedSourceHash: 'staged-hash',
        stagedRevision: 3,
        contextVersion: 'geometry-v1',
        diagnostics: [],
      },
    })

    await emit({ type: 'message.delta', runId: 'run-1', sequence: 5, delta: '수정했습니다.' })
    await emit({
      type: 'run.completed',
      runId: 'run-1',
      sequence: 6,
      message: '수정과 검증을 완료했습니다.',
      finalBundle: bundle,
      baseHash: 'base-hash',
      sourceHash: 'staged-hash',
      stagedRevision: 3,
      geometryContextVersion: 'geometry-v1',
      sessionContextEnvelope: 'sealed-after',
      contextUsage: { contextTokens: 1200, cachedTokens: 400, cacheWriteTokens: 100, compacted: true },
      provenance: [{ kind: 'catalog', label: 'Steady-state heat solver', resourceId: 9 }],
    })

    await waitFor(() => expect(applyBundle).toHaveBeenCalledOnce())
    expect(applyBundle).toHaveBeenCalledWith(expect.objectContaining({ stagedRevision: 3 }))
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        credentialVersion: 4,
        experimentId: 7,
        permissionFingerprint: 'user',
      }),
      'sealed-after',
    )
    expect(await screen.findByText('수정과 검증을 완료했습니다.')).toBeVisible()
    await user.click(screen.getByText(/Agent 작업 5개/))
    await user.click(screen.getByText(/사용한 데이터와 카탈로그 1개/))
    expect(screen.getByText('카탈로그 검색')).toBeVisible()
    expect(screen.getByText('Workbench 컴파일·평가')).toBeVisible()
    expect(screen.getByText('Agent 컨텍스트 구성')).toBeVisible()
    expect(screen.getByText('staged source 수정')).toBeVisible()
    expect(screen.getByText('Steady-state heat solver')).toBeVisible()
    expect(screen.getByText('변경 반영됨')).toBeVisible()
  })

  it('keeps the editor unchanged and reports a CAS conflict', async () => {
    const user = userEvent.setup()
    const applyBundle = vi
      .fn()
      .mockResolvedValue({ status: 'conflicted', message: 'Experiment가 실행 중 변경되었습니다.' })
    const validation = vi.fn().mockResolvedValue({
      status: 'valid',
      result: {
        status: 'valid',
        sourceHash: 'next-hash',
        requestedSourceHash: 'next-hash',
        stagedRevision: 1,
        contextVersion: 'geometry-v1',
      },
    })
    const { bundle } = renderWorkspace({
      onApplyStagedBundle: applyBundle,
      onValidateStagedBundle: validation,
    })

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), 'source를 수정해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    await emit({ type: 'run.started', runId: 'run-2', sequence: 0 })
    await emit({
      type: 'client_tool.request',
      runId: 'run-2',
      sequence: 1,
      callId: 'compile-2',
      name: 'validate_workspace',
      stagedBundle: bundle,
      stagedRevision: 1,
      sourceHash: 'next-hash',
      geometryContextVersion: 'geometry-v1',
    })
    await emit({
      type: 'run.completed',
      runId: 'run-2',
      sequence: 2,
      message: '수정했습니다.',
      finalBundle: bundle,
      baseHash: 'base-hash',
      sourceHash: 'next-hash',
      stagedRevision: 1,
      geometryContextVersion: 'geometry-v1',
      sessionContextEnvelope: null,
      contextUsage: null,
      provenance: [],
    })

    await waitFor(() => expect(screen.getAllByText('Experiment가 실행 중 변경되었습니다.')).toHaveLength(2))
    expect(screen.getAllByText('Experiment가 실행 중 변경되었습니다.')[1]).toBeVisible()
    expect(screen.getByText('충돌')).toBeVisible()
    expect(mocks.saveSession).not.toHaveBeenCalled()
  })

  it('refuses a completed bundle whose staged revision was not the last browser-validated revision', async () => {
    const user = userEvent.setup()
    const validation = vi.fn().mockResolvedValue({
      status: 'valid',
      result: {
        status: 'valid',
        sourceHash: 'revision-hash',
        requestedSourceHash: 'revision-hash',
        stagedRevision: 1,
        contextVersion: 'geometry-v1',
      },
    })
    const applyBundle = vi.fn().mockResolvedValue({ status: 'applied' })
    const { bundle } = renderWorkspace({ onApplyStagedBundle: applyBundle, onValidateStagedBundle: validation })

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), 'revision을 검증해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    await emit({ type: 'run.started', runId: 'run-revision', sequence: 0 })
    await emit({
      type: 'client_tool.request',
      runId: 'run-revision',
      sequence: 1,
      callId: 'compile-revision',
      name: 'validate_workspace',
      stagedBundle: bundle,
      stagedRevision: 1,
      sourceHash: 'revision-hash',
      geometryContextVersion: 'geometry-v1',
    })
    await emit({
      type: 'run.completed',
      runId: 'run-revision',
      sequence: 2,
      message: '완료했습니다.',
      finalBundle: bundle,
      baseHash: 'base-hash',
      sourceHash: 'revision-hash',
      stagedRevision: 2,
      geometryContextVersion: 'geometry-v1',
      sessionContextEnvelope: 'must-not-save',
      contextUsage: null,
      provenance: [],
    })

    expect(applyBundle).not.toHaveBeenCalled()
    expect(mocks.saveSession).not.toHaveBeenCalled()
    expect(await screen.findByText('검증 불일치')).toBeVisible()
  })

  it('sends run.cancel for the active server run', async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), '긴 작업을 시작해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    await emit({ type: 'run.started', runId: 'run-cancel', sequence: 0 })
    await user.click(screen.getByRole('button', { name: '중지' }))

    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'run.cancel', runId: 'run-cancel' })
    expect(screen.getByText('취소 중')).toBeVisible()
  })

  it('aborts browser validation and suppresses its late client result when the run is cancelled', async () => {
    const user = userEvent.setup()
    let finishValidation: (result: { status: 'valid'; result: { requestedSourceHash: string } }) => void = () =>
      undefined
    const validation = vi.fn(
      (request: unknown) =>
        new Promise<{ status: 'valid'; result: { requestedSourceHash: string } }>((resolve) => {
          void request
          finishValidation = resolve
        }),
    )
    const { bundle } = renderWorkspace({ onValidateStagedBundle: validation })

    await screen.findByText('OpenAI · gpt-5.6-luna')
    await user.type(screen.getByLabelText('AI Helper 질문'), '검증을 시작해 줘')
    await user.click(screen.getByRole('button', { name: '전송' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalled())
    await emit({ type: 'run.started', runId: 'run-abort', sequence: 0 })

    let pendingValidation: void | Promise<void>
    act(() => {
      pendingValidation = mocks.callbacks?.onEvent({
        type: 'client_tool.request',
        runId: 'run-abort',
        sequence: 1,
        callId: 'compile-late',
        name: 'validate_workspace',
        stagedBundle: bundle,
        stagedRevision: 1,
        sourceHash: 'late-hash',
        geometryContextVersion: 'geometry-v1',
      })
    })
    await waitFor(() => expect(validation).toHaveBeenCalledOnce())
    const signal = (validation.mock.calls[0]?.[0] as { signal: AbortSignal }).signal

    await user.click(screen.getByRole('button', { name: '중지' }))
    expect(signal.aborted).toBe(true)
    finishValidation({ status: 'valid', result: { requestedSourceHash: 'late-hash' } })
    await act(async () => {
      await pendingValidation
    })

    expect(mocks.send).toHaveBeenCalledWith({ type: 'run.cancel', runId: 'run-abort' })
    expect(mocks.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'client_tool.result', callId: 'compile-late' }),
    )
  })

  it('blocks a run until both the provider credential and exact workspace identity are ready', async () => {
    mocks.listProviders.mockResolvedValue([provider(false)])
    const onRequestLogin = vi.fn()
    const user = userEvent.setup()
    renderWorkspace({ baseHash: null, geometryContextVersion: null, onRequestLogin })

    expect(await screen.findByText(/API key를 등록해야 Agent를 실행할 수 있습니다/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Account 열기' }))
    expect(onRequestLogin).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '전송' })).toBeDisabled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})

function provider(configured: boolean) {
  return {
    id: 'openai',
    label: 'OpenAI',
    configured,
    credentialVersion: configured ? 4 : null,
    updatedAt: null,
    models: [
      {
        id: 'gpt-5.6-luna',
        label: 'gpt-5.6-luna',
        reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
  }
}

function renderWorkspace({
  baseHash = 'base-hash',
  geometryContextVersion = 'geometry-v1',
  onApplyStagedBundle,
  onRequestLogin,
  onValidateStagedBundle,
}: {
  baseHash?: string | null
  geometryContextVersion?: string | null
  onApplyStagedBundle?: Parameters<typeof AiHelperWorkspace>[0]['onApplyStagedBundle']
  onRequestLogin?: () => void
  onValidateStagedBundle?: Parameters<typeof AiHelperWorkspace>[0]['onValidateStagedBundle']
} = {}) {
  const bundle = createExperimentSourceBundle({
    'experiment.tsx': "export default experiment({ lengthUnit: 'mm' })",
    'geometry.tsx': 'export {}\n',
    'material.tsx': 'export {}\n',
    'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    pass',
    'tasks/thermal.tsx': 'export default defineTask({})',
  })
  const workbench = {
    experiment: createCadSourceDocument('experiment', bundle),
    experimentId: 7,
    agentWorkspaceSession: 11,
    experimentDocument: {
      diagnostics: Array.from({ length: 21 }, (_, index) => ({
        code: index,
        file: 'tasks/thermal.tsx',
        message: '긴 진단 메시지'.repeat(250),
        phase: 'semantic',
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        severity: 'error',
      })),
      revision: 2,
      status: 'Ready',
      successfulRevision: 2,
    },
  } as unknown as CaeWorkbenchState
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AiHelperWorkspace
        activeExperimentFile="tasks/thermal.tsx"
        activeTab="ai-helper"
        baseHash={baseHash}
        geometryContextVersion={geometryContextVersion}
        onApplyStagedBundle={onApplyStagedBundle}
        onRequestLogin={onRequestLogin}
        onValidateStagedBundle={onValidateStagedBundle}
        workbench={workbench}
      />
    </QueryClientProvider>,
  )
  return { bundle }
}

async function emit(event: unknown) {
  await act(async () => {
    await mocks.callbacks?.onEvent(event)
  })
}
