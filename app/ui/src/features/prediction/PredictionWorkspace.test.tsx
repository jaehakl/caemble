import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { PredictionAssetsSnapshot } from './assetManagement'
import type { PredictionExecution } from './execution'
import type { PredictionWorkspaceCommand } from './PredictionWorkspace'
import { PredictionWorkspace } from './PredictionWorkspace'
import { calculation, context, grid, model, provenance, remoteFixture, setup, varsSchema } from './forward.fixture'

const mocks = vi.hoisted(() => ({
  remote: null as unknown,
  assets: null as unknown,
  state: null as unknown,
  restore: vi.fn(),
  context: vi.fn(),
  calculations: vi.fn(),
  calculate: vi.fn(),
  viewer: vi.fn(),
  chrome: vi.fn(),
  save: vi.fn(),
  records: vi.fn(),
  validation: vi.fn(),
}))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'user:test' }))
vi.mock('@/lib/calculation', async (original) => ({
  ...(await original<typeof import('@/lib/calculation')>()),
  runCalculation: mocks.calculate,
}))
vi.mock('./remoteExecution', () => ({
  RemotePredictionExecution: class {
    constructor() {
      return mocks.remote as PredictionExecution
    }
  },
}))
vi.mock('./usePredictionAssets', () => ({ usePredictionAssets: () => mocks.assets }))
vi.mock('./setupPersistence', () => ({ restorePredictionSetup: mocks.restore, persistPredictionSetup: vi.fn() }))
vi.mock('./predictionContextData', async (original) => ({
  ...(await original<typeof import('./predictionContextData')>()),
  loadPredictionContextData: mocks.context,
  loadPredictionCalculations: mocks.calculations,
  loadPredictionValidationData: mocks.validation,
}))
vi.mock('./PredictionModelSummary', () => ({ PredictionModelSummary: () => <div>데이터·모델 관리</div> }))
vi.mock('./RemotePredictionSettings', () => ({ RemotePredictionSettings: () => null }))
vi.mock('@/components/vars-editor', () => ({
  VarsEditor: ({ onValueChange }: { onValueChange: (vars: { x: number }) => void }) => (
    <button onClick={() => onValueChange({ x: 0.8 })}>Change Vars</button>
  ),
}))
vi.mock('@/components/tensor-editor', () => ({
  TensorEditor: ({ value }: { value: unknown }) => <output>{JSON.stringify(value)}</output>,
}))

let remote = remoteFixture()
let commandId = 0
const activity = () => undefined
const login = () => undefined
const editRecords = mocks.records
function Harness({
  active = true,
  ready = true,
  authenticated = true,
}: {
  active?: boolean
  ready?: boolean
  authenticated?: boolean
}) {
  const [vars, setVars] = useState({ x: 0.5 })
  const [command, setCommand] = useState<PredictionWorkspaceCommand | null>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const workbench = {
    experimentId: 3,
    workspaceSession: 1,
    candidateVars: vars,
    experiment: { sourceBundle: { files: { 'experiment.ts': 'source' } } },
    experimentRecord: { source_hash: 'source' },
    experimentManageable: true,
    experimentClean: true,
    experimentDocument: {
      revision: 1,
      successfulRevision: ready ? 1 : 0,
      status: ready ? 'Ready' : 'Evaluating',
      varsSchema,
      variables: ready ? vars : null,
      predictionCandidate: ready ? { sourceHash: 'source', records: ['heat.T'] } : null,
      simulationProgram: { boxGrids: { 'heat.T': grid }, resultContracts: {}, recordedData: {} },
      draftTaskNames: [],
    },
    setPredictionRecords: editRecords,
    setCandidateVariables: (next: { x: number }) => {
      setVars(next)
      return true
    },
    measurementActions: { busy: false, saveAndRunCurrentAsync: mocks.save, cancel: vi.fn() },
    calculationDataActions: { busy: false },
  } as unknown as CaeWorkbenchState
  return (
    <>
      <div ref={setContainer} />
      <button onClick={() => setCommand({ id: ++commandId, type: 'validate' })}>Save & Run test</button>
      <PredictionWorkspace
        active={active}
        authenticated={authenticated}
        dataReadable
        onRequestLogin={login}
        command={command}
        onActivity={activity}
        onChromeStateChange={mocks.chrome}
        onViewerStateChange={mocks.viewer}
        varsContainer={container}
        workbench={workbench}
      />
    </>
  )
}
function view(props: Parameters<typeof Harness>[0] = {}) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness {...props} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  commandId = 0
  remote = remoteFixture()
  mocks.remote = remote
  const route = setup.routes!.forward!
  mocks.state = {
    models: [],
    datasets: [],
    storages: [],
    launchers: [],
    operations: [],
    tasks: [],
    loading: false,
    error: null,
    listErrors: {},
    launchersLoaded: true,
  } satisfies PredictionAssetsSnapshot
  mocks.assets = {
    subscribe: () => () => undefined,
    getSnapshot: () => mocks.state,
    refresh: vi.fn(),
    registerDeletionHandler: () => () => undefined,
  }
  mocks.restore.mockReturnValue({ ...setup, routes: { forward: route } })
  mocks.context.mockResolvedValue(context)
  mocks.calculations.mockResolvedValue([])
  mocks.calculate.mockResolvedValue({ dtype: 'float64', shape: [], axes: [], data: 15 })
  mocks.save.mockResolvedValue({ measurementId: 100 })
  mocks.validation.mockResolvedValue({ actual: [], currentSourceFingerprints: new Map() })
})
afterEach(cleanup)

it('opens directly and predicts BoxGrid with zero Calculations; Save & Run remains available', async () => {
  render(view())
  await waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
  await waitFor(() =>
    expect(mocks.viewer).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          source: expect.objectContaining({ kind: 'prediction', model: provenance }),
        }),
      }),
    ),
  )
  expect(mocks.records).toHaveBeenCalledWith(['heat.T'])
  expect(remote.prepare).not.toHaveBeenCalled()
  expect(mocks.calculate).not.toHaveBeenCalled()
  expect(mocks.chrome).toHaveBeenLastCalledWith(expect.objectContaining({ canValidate: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Save & Run test' }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
  expect(mocks.validation).toHaveBeenCalledWith(expect.objectContaining({ calculationIds: [] }))
  expect(remote.load).toHaveBeenCalledOnce()
})

it('waits for matching Candidate preparation, then reuses its model through Vars and tab changes', async () => {
  const { rerender } = render(view({ ready: false }))
  await waitFor(() => expect(mocks.context).toHaveBeenCalled())
  expect(remote.predict).not.toHaveBeenCalled()
  rerender(view({ ready: true }))
  await waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Change Vars' }))
  await waitFor(() => expect(remote.predict).toHaveBeenCalledTimes(2))
  expect(remote.load).toHaveBeenCalledOnce()
  rerender(view({ active: false }))
  rerender(view({ active: true }))
  await waitFor(() =>
    expect(mocks.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ varsFingerprint: expect.any(String) })),
  )
  expect(remote.load).toHaveBeenCalledOnce()
  expect(remote.predict).toHaveBeenCalledTimes(2)
  expect(remote.dispose).not.toHaveBeenCalled()
})

it('adds Calculation after prediction without reloading or predicting, and preserves source', async () => {
  mocks.calculations.mockResolvedValue([calculation])
  render(view())
  await waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Temperature' }))
  await waitFor(() => expect(mocks.calculate).toHaveBeenCalledOnce())
  expect(remote.predict).toHaveBeenCalledOnce()
  expect(remote.load).toHaveBeenCalledOnce()
  expect(screen.getByText('예측 기반 분석 · Model r1')).toBeInTheDocument()
})

it('cancels immediately, discards a late result and retries only on explicit request', async () => {
  let finish!: (value: Awaited<ReturnType<typeof remote.predict>>) => void
  remote.predict.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { rerender } = render(view())
  await waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '취소' }))
  expect(
    screen.getAllByText('Prediction 작업을 취소했습니다. 다시 예측하거나 Vars를 바꾸세요.').length,
  ).toBeGreaterThan(0)
  finish({
    direction: 'forward',
    fingerprint: model.fingerprint,
    output: [],
    extrapolatedInputKeys: [],
    constantInputKeysChanged: [],
    queryDiagnostics: [],
    provenance,
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.viewer).not.toHaveBeenCalledWith(expect.objectContaining({ preview: expect.anything() }))
  rerender(view({ active: false }))
  rerender(view({ active: true }))
  expect(remote.predict).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '예측' }))
  await waitFor(() => expect(remote.predict).toHaveBeenCalledTimes(2))
  expect(remote.load).toHaveBeenCalledOnce()
})

it('keeps optional Calculation lookup failure from blocking remote prediction', async () => {
  mocks.calculations.mockRejectedValue(new Error('unavailable'))
  render(view())
  await waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
  expect(
    await screen.findByText('Calculation 목록을 불러오지 못했습니다. BoxGrid 예측은 사용할 수 있습니다.'),
  ).toBeInTheDocument()
})

it('never invokes remote prediction anonymously', async () => {
  render(view({ authenticated: false }))
  await screen.findByRole('button', { name: '로그인' })
  expect(remote.load).not.toHaveBeenCalled()
  expect(remote.predict).not.toHaveBeenCalled()
})

it('renders a prediction while optional Calculation metadata is still pending', async () => {
  mocks.calculations.mockReturnValue(new Promise(() => undefined))
  render(view())
  await waitFor(() =>
    expect(mocks.viewer).toHaveBeenCalledWith(expect.objectContaining({ preview: expect.anything() })),
  )
  expect(remote.predict).toHaveBeenCalledOnce()
})

it('keeps explicitly cancelled postprocessing stopped across tab reentry', async () => {
  mocks.restore.mockReturnValue({ ...setup, calculationIds: [2] })
  mocks.calculations.mockResolvedValue([calculation])
  mocks.calculate.mockReturnValue(new Promise(() => undefined))
  const { rerender } = render(view())
  await waitFor(() => expect(mocks.calculate).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '취소' }))
  rerender(view({ active: false }))
  rerender(view({ active: true }))
  await waitFor(() => expect(mocks.chrome).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false })))
  expect(mocks.calculate).toHaveBeenCalledOnce()
  expect(remote.load).toHaveBeenCalledOnce()
})

it('automatically retries a failed Candidate when a different accessible Launcher is selected', async () => {
  const oldRoute = setup.routes!.forward!
  const nextStorage = '22222222222222222222222222222222'
  const nextLauncher = '10000000-0000-4000-8000-000000000009'
  mocks.state = {
    ...(mocks.state as PredictionAssetsSnapshot),
    models: [
      {
        id: provenance.modelId,
        name: 'Forward',
        direction: 'forward',
        state: 'active',
        revisions: [
          {
            revision: 1,
            state: 'ready',
            definition: { algorithm: { kind: 'knn' } },
            replicas: [
              { id: 'copy-one', storage_id: oldRoute.storageId, state: 'present' },
              { id: 'copy-two', storage_id: nextStorage, state: 'present' },
            ],
          },
        ],
      },
    ],
    storages: [
      {
        storage_id: oldRoute.storageId,
        kind: 'predictor_local',
        name: 'first',
        accesses: [{ launcher_id: oldRoute.launcherId, connected: true }],
      },
      {
        storage_id: nextStorage,
        kind: 'predictor_local',
        name: 'second',
        accesses: [{ launcher_id: nextLauncher, connected: true }],
      },
    ],
  } as unknown as PredictionAssetsSnapshot
  remote.predict.mockRejectedValueOnce(new Error('old route failed'))
  render(view())
  await waitFor(() => expect(screen.getAllByText('old route failed').length).toBeGreaterThan(0))
  const replacement = remoteFixture()
  mocks.remote = replacement
  fireEvent.change(screen.getByRole('combobox', { name: 'Prediction Launcher' }), {
    target: { value: `${nextStorage}:${nextLauncher}` },
  })
  await waitFor(() => expect(replacement.predict).toHaveBeenCalledOnce())
  expect(replacement.prepare).not.toHaveBeenCalled()
  expect(remote.dispose).toHaveBeenCalledOnce()
})
