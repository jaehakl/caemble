import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { usePreflight } from './usePreflight'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { ExperimentSourceDocument } from '@/lib/cad/source'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
  read: vi.fn(),
  resolve: vi.fn(),
}))
vi.mock('@/api/http', () => ({ browserClient: { request: mocks.request } }))
vi.mock('@/api/cae', () => ({ caeBatches: { cancel: mocks.cancel, read: mocks.read } }))
vi.mock('@/api/submitArtifact', () => ({ sha256Bytes: async () => 'a'.repeat(64), submitArtifact: mocks.submit }))
vi.mock('@/api/objectStorage', () => ({ resolveObjects: mocks.resolve }))
vi.mock('@/features/viewer/workspace/catalogRuntime', () => ({
  fetchCatalogRuntimeSlice: async () => ({ catalogRevision: 'revision' }),
}))
vi.mock('@/lib/cad/source', () => ({ cadSourceHash: async () => 'source' }))
vi.mock('@/lib/material/resolution', () => ({ materialVarsHash: (value: unknown) => JSON.stringify(value) }))

const experiment: ExperimentSourceDocument = {
  kind: 'experiment',
  sourceBundle: { files: { 'simulate.py': 'source' } },
}
const document = {
  variables: {},
  evaluatedSnapshot: { sourceHash: 'source', variables: {} },
  revision: 1,
  successfulRevision: 1,
  evaluationTimeoutMs: 3000,
  scene: { frozen: true },
  measurement: { frozen: true },
} as unknown as CadDocumentController
const payload = {
  id: 'batch',
  expires_at: '2099-01-01T00:00:00Z',
  source_hash: 'source',
  vars_hash: '{}',
  result_contracts: { field: { visualization: { kind: 'tensor' } } },
  schemas: { field: { dtype: 'float32', tensorOrder: 1 } },
  recorded_data: { field: { shape: [2], storage: { kind: 'inline', value: [1, 2] } } },
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.cancel.mockResolvedValue({})
  mocks.request.mockResolvedValue(payload)
  mocks.resolve.mockImplementation(async (_client, value) => value)
  mocks.submit.mockImplementation(async (options) => {
    options.onRegistered('batch')
    return { id: 'batch', state: 'completed', succeeded: 1 }
  })
})

it('submits a temporary candidate with unchanged settings and retains its snapshot', async () => {
  const { result, rerender } = renderHook(({ doc, key }) => usePreflight(experiment, doc, key), {
    initialProps: { doc: document, key: 'first' },
  })
  await act(async () => {
    await result.current.run()
  })
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({
    experimentId: null,
    preflight: true,
    artifact: { mode: 'candidate' },
  })
  expect(result.current.result?.document).toBe(document)
  rerender({ doc: { ...document, revision: 2 }, key: 'first' })
  expect(result.current.result?.document).toBe(document)
  rerender({ doc: document, key: 'measurement-2' })
  expect(result.current.result).toBeNull()
  await act(async () => {
    await result.current.run()
  })
  expect(mocks.submit.mock.lastCall?.[0].preflight).toBe(true)
})

it('isolates one failed result download', async () => {
  mocks.request.mockResolvedValue({
    ...payload,
    result_contracts: { ...payload.result_contracts, broken: payload.result_contracts.field },
    schemas: { ...payload.schemas, broken: payload.schemas.field },
    recorded_data: { ...payload.recorded_data, broken: { fail: true } },
  })
  mocks.resolve.mockImplementation(async (_client, value) => {
    if (value.fail) throw new Error('missing object')
    return value
  })
  const { result } = renderHook(() => usePreflight(experiment, document, 'first'))
  await act(async () => {
    await result.current.run()
  })
  expect(result.current.result?.data.field).toEqual(payload.recorded_data.field)
  expect(result.current.result?.errors.broken).toBe('missing object')
  expect(result.current.error).toBeNull()
  expect(result.current.status).toBe('일부 결과 불러오기 실패')
  expect(result.current.busy).toBe(false)
})

it.each([{}, { field: null }])('reports missing declared results and stops loading: %j', async (recorded_data) => {
  mocks.request.mockResolvedValue({ ...payload, recorded_data })
  const { result } = renderHook(() => usePreflight(experiment, document, 'first'))
  await act(async () => {
    await result.current.run()
  })
  expect(result.current.result?.errors.field).toBe('응답에 선언된 결과 데이터가 없습니다.')
  expect(result.current.status).toBe('결과 불러오기 실패')
  expect(result.current.busy).toBe(false)
})

it('ends loading when the server reports a lost snapshot', async () => {
  mocks.request.mockRejectedValue(new Error('이 Preflight의 결과 기록이 유실되어 조회할 수 없습니다.'))
  const { result } = renderHook(() => usePreflight(experiment, document, 'first'))
  await act(async () => {
    await result.current.run()
  })
  expect(result.current.error).toContain('유실')
  expect(result.current.result).toBeNull()
  expect(result.current.busy).toBe(false)
})

it('cancels an active job on selection change without publishing its result', async () => {
  mocks.submit.mockImplementation(async (options) => {
    options.onRegistered('batch')
    return { id: 'batch', state: 'running', succeeded: 0 }
  })
  const { result, rerender } = renderHook(({ key }) => usePreflight(experiment, document, key), {
    initialProps: { key: 'first' },
  })
  let pending: Promise<void>
  act(() => {
    pending = result.current.run()
  })
  await waitFor(() => expect(result.current.status).toBe('계산 중'))
  rerender({ key: 'next' })
  await act(async () => {
    await pending!
  })
  expect(mocks.cancel).toHaveBeenCalledWith('batch')
  expect(result.current.result).toBeNull()
  expect(result.current.busy).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
})

it('waits for the requested Candidate generation and submits its new data exactly once', async () => {
  const generateCandidate = vi.fn(() => 2)
  const initial = {
    ...document,
    generateCandidate,
    candidateGeneration: 1,
    completedCandidateGeneration: 1,
    successfulCandidateGeneration: 1,
  }
  const { result, rerender } = renderHook(({ doc }) => usePreflight(experiment, doc, 'same'), {
    initialProps: { doc: initial },
  })
  await act(async () => {
    await result.current.run()
  })
  const previous = result.current.result
  mocks.submit.mockClear()
  await act(async () => {
    await result.current.run(true)
    await result.current.run(true)
  })
  expect(generateCandidate).toHaveBeenCalledTimes(1)
  expect(result.current.result).toBe(previous)
  expect(result.current.busy).toBe(true)
  rerender({ doc: { ...initial, revision: 2, candidateGeneration: 2 } })
  expect(mocks.submit).not.toHaveBeenCalled()
  const completed = {
    ...initial,
    revision: 2,
    successfulRevision: 2,
    candidateGeneration: 2,
    completedCandidateGeneration: 2,
    successfulCandidateGeneration: 2,
  }
  rerender({ doc: completed })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(result.current.result?.document).toBe(completed)
  rerender({ doc: { ...completed } })
  expect(mocks.submit).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'source', 'failure', 'session'])('does not execute after pending generation %s', async (reason) => {
  const initial = {
    ...document,
    generateCandidate: () => 2,
    candidateGeneration: 1,
    completedCandidateGeneration: 1,
    successfulCandidateGeneration: 1,
  }
  const { result, rerender } = renderHook(({ doc, source, key }) => usePreflight(source, doc, key), {
    initialProps: { doc: initial, source: experiment, key: 'same' },
  })
  await act(async () => {
    await result.current.run(true)
  })
  if (reason === 'cancel')
    await act(async () => {
      await result.current.cancel()
    })
  rerender({
    doc: {
      ...initial,
      revision: 2,
      candidateGeneration: 2,
      completedCandidateGeneration: 2,
      successfulCandidateGeneration: reason === 'failure' ? 1 : 2,
    },
    source: reason === 'source' ? { ...experiment, sourceBundle: { files: { 'simulate.py': 'changed' } } } : experiment,
    key: reason === 'session' ? 'different' : 'same',
  })
  expect(result.current.busy).toBe(false)
  expect(mocks.submit).not.toHaveBeenCalled()
})

// Exercise the actual Preflight snapshot/payload → WorkbenchViewer boundary.
// The browser suite exercises the child renderer and its spatial-axis controls.
vi.mock('@/features/viewer/viewer/BoxGridResult', () => ({
  BoxGridResult: ({
    canOverlayGeometry,
    geometryBlockedReason,
  }: {
    canOverlayGeometry: boolean
    geometryBlockedReason?: string
  }) => (
    <button disabled={!canOverlayGeometry} title={geometryBlockedReason}>
      Geometry 겹치기
    </button>
  ),
}))
vi.mock('@/features/viewer/viewer/CadViewer', () => ({ default: () => <div>Geometry preview</div> }))

it('allows a Preflight Box Grid without coordinateSpace and distinguishes actual overlay blockers', async () => {
  const contract = {
    task: 'solid',
    output: 'field',
    solver: { name: 'fixture', version: '1' },
    catalogRevision: 'frozen',
    artifactType: 'fixture@1',
    schema: payload.schemas.field,
    visualization: { kind: 'box-grid' },
  }
  mocks.request.mockResolvedValue({ ...payload, result_contracts: { field: contract } })
  const { result } = renderHook(() => usePreflight(experiment, document, 'overlay'))
  await act(async () => {
    await result.current.run()
  })
  const preview = result.current.result!
  expect(preview).not.toBeNull()
  const props: Parameters<typeof WorkbenchViewer>[0] = {
    experiment: preview.experiment,
    experimentDocument: preview.document,
    resultContracts: {
      ...preview.payload.result_contracts,
      scalar: { ...preview.payload.result_contracts.field, visualization: { kind: 'tensor' } },
    },
    resultSourceHash: preview.payload.source_hash,
    resultVarsHash: preview.payload.vars_hash,
    recordedData: { ...preview.data, scalar: preview.data.field },
    recordedRules: preview.rules,
    autoSelectResult: true,
    onFindSelectionSource: vi.fn(),
    onSelectionQueryChange: vi.fn(),
    onSelectionSourcePathsChange: vi.fn(),
    selectionQuery: null,
    selectionSourceStatus: {},
  }
  const { rerender } = render(<WorkbenchViewer {...props} />)
  expect(screen.getByRole('button', { name: 'Output · field' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Geometry · 90%' })).toBeEnabled()
  expect(screen.queryByText(/source가 달라|Vars가 달라/)).toBeNull()
  for (const [override, reason] of [
    [{ resultSourceHash: 'different' }, /source가 다릅니다/],
    [{ resultVarsHash: 'different' }, /Vars가 다릅니다/],
    [{ resultSourceHash: undefined }, /비교 정보가 없어/],
    [{ resultVarsHash: undefined }, /비교 정보가 없어/],
    [{ experimentDocument: { ...document, scene: null } }, /Geometry가 준비되지/],
    [{ experimentDocument: { ...document, evaluatedSnapshot: null } }, /Geometry가 준비되지/],
  ] as const) {
    rerender(<WorkbenchViewer {...props} {...override} />)
    expect(screen.getByRole('button', { name: 'Geometry · 90%' })).toBeEnabled()
    expect(screen.getAllByText(reason)[0]).toBeInTheDocument()
  }
  rerender(
    <WorkbenchViewer
      {...props}
      resultContracts={{ field: { ...preview.payload.result_contracts.field, visualization: { kind: 'tensor' } } }}
    />,
  )
  expect(screen.getByRole('separator', { name: '3D와 Output 높이 조절' })).toBeInTheDocument()
})

it('reports each failed run once without replaying errors on rerender', async () => {
  const onActivity = vi.fn()
  mocks.submit.mockRejectedValue(new Error('입력 업로드 실패'))
  const { result, rerender } = renderHook(() => usePreflight(experiment, document, 'first', onActivity))
  await act(async () => {
    await result.current.run()
  })
  expect(onActivity).toHaveBeenCalledTimes(1)
  expect(onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error', message: '입력 업로드 실패' }))
  rerender()
  expect(onActivity).toHaveBeenCalledTimes(1)
  await act(async () => {
    await result.current.run()
  })
  expect(onActivity).toHaveBeenCalledTimes(2)
})

it('reports result loading failures but does not log successful completion', async () => {
  const onActivity = vi.fn()
  const { result } = renderHook(() => usePreflight(experiment, document, 'first', onActivity))
  await act(async () => {
    await result.current.run()
  })
  expect(onActivity).not.toHaveBeenCalled()
  mocks.resolve.mockRejectedValue(new Error('결과 로드 실패'))
  await act(async () => {
    await result.current.run()
  })
  expect(onActivity).toHaveBeenCalledTimes(1)
  expect(onActivity).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'preflight.result.failed', details: { result: 'field', batchId: 'batch' } }),
  )
})
