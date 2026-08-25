// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataTensorAccessor } from '../../lib/cad'
import { installCatalogRuntimeSlice, registerSourceCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { RuntimeActivityDraft } from '@/features/runtime-console'
import { releaseRecordedDataAttachments, simulate } from './client'
import { serializeCaeRequest } from './request'

const sdk = vi.hoisted(() => ({ clientOptions: vi.fn(), runJob: vi.fn() }))
const api = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('@/api/http', () => ({ API_URL: '/api', request: api.request }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    constructor(options: unknown) {
      sdk.clientOptions(options)
    }

    runJob = sdk.runJob
  },
}))

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

function measurementFixture() {
  const recordedData = {
    values: {
      dtype: 'float64' as const,
      unit: '{fraction}' as const,
      quantityKind: 'DimensionlessRatio' as const,
      tensorOrder: 0,
      axes: [{ length: 2 }],
    },
  }
  const scene = {
    geometryFormatVersion: 1,
    geometryHash: 'c'.repeat(64),
    lengthUnit: 'mm',
    roots: [
      {
        id: 'part',
        materialRole: 'body',
        material: { name: 'Copper', source: 'test', version: '1' },
        node: {
          kind: 'primitive',
          nodeId: 'part',
          primitive: 'box',
          parameters: { size: [1, 1, 1] },
        },
      },
    ],
    geometryGroups: [],
    surfaceGroups: [],
  }
  return {
    measurement: {
      kind: 'measurement',
      experiment: {
        kind: 'experiment',
        sourceHash: 'b'.repeat(64),
        variables: {},
        varsSchema: {},
        scene,
        taskScenes: { electric: scene },
        simulationProgram: {
          formatVersion: 5,
          simulationApiVersion: 3,
          pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
          tasks: {
            electric: {
              kernel: { name: 'dc-current-density', version: '0.1.0' },
              config: {},
            },
          },
          recordedData,
        },
      },
      materialParameters: {
        schemaVersion: 1,
        materials: {
          Copper: {
            'electrical.conductivity': {
              origin: 'source',
              value: {
                dtype: 'float64',
                unit: 'S.cm-1',
                value: [
                  [2, 0, 0],
                  [0, 2, 0],
                  [0, 0, 2],
                ],
              },
              source: 'test',
              version: '1',
              materialId: null,
              materialParameterId: null,
            },
          },
        },
      },
      materialWarnings: [],
      taskMaterialParameters: { electric: { schemaVersion: 1, materials: {} } },
      taskMaterialWarnings: { electric: [] },
    },
    recordedData,
  }
}

describe('CAE session client', () => {
  beforeEach(() => {
    sdk.runJob.mockReset()
    sdk.clientOptions.mockReset()
    api.request.mockReset()
    api.request.mockResolvedValue({ ok: true })
    const catalog = {
      schemaVersion: 1,
      catalogRevision: 'test',
      solvers: [
        {
          name: 'dc-current-density',
          version: '0.1.0',
          contractDigest: 'd'.repeat(64),
          descriptor: {} as never,
        },
      ],
      quantityKinds: [
        {
          name: 'DimensionlessRatio',
          domain: 'general',
          tensorOrder: 0,
          description: 'Ratio',
          opaque: false,
          applicableUnits: ['{fraction}'],
        },
        {
          name: 'electromagnetism.ElectricConductivity',
          domain: 'electromagnetism',
          tensorOrder: 2,
          description: null,
          opaque: false,
          applicableUnits: ['S.m-1', 'S.cm-1'],
        },
      ],
      materialParameters: [
        {
          key: 'electrical.conductivity',
          domain: 'electrical',
          labelKo: '전기 전도도',
          quantityKind: 'electromagnetism.ElectricConductivity',
          specialQualifiers: [],
        },
      ],
      materialModels: [],
      materialGlobalQualifiers: [],
      warnings: [],
    } satisfies CatalogRuntimeSlice
    installCatalogRuntimeSlice(catalog)
    registerSourceCatalogRuntimeSlice('b'.repeat(64), catalog)
  })

  it('sends the built Measurement with exact Solver contracts, ACKs records, and returns RecordedData only', async () => {
    const fixture = measurementFixture()
    const bytes = new Float64Array([1.25, 2.5]).buffer
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        payload: {
          kind: 'record',
          sequence: 1,
          name: 'values',
          tensor: {
            shape: [2],
            storage: { kind: 'attachments', ids: ['record-1-0'], byteLength: 16 },
          },
        },
        files: [
          {
            id: 'record-1-0',
            name: 'values.bin',
            mimeType: 'application/octet-stream',
            size: 16,
            blob: { arrayBuffer: async () => bytes } as Blob,
          },
        ],
      })
      .mockResolvedValueOnce({
        payload: { kind: 'complete', sequence: 2, recordSequences: [1] },
        files: [],
      })
    const finish = vi.fn().mockResolvedValue(undefined)
    sdk.runJob.mockResolvedValue({
      payload: { kind: 'started', runId: 'run-1', maxRunSeconds: 7200 },
      files: [],
      session: { call, finish, close: vi.fn(), jobId: 'job-1', closed: false },
    })
    const onRecord = vi.fn()
    const activities: RuntimeActivityDraft[] = []

    const result = await simulate(fixture.measurement as never, {
      onActivity: (activity) => activities.push(activity),
      onRecord,
    })

    expect(sdk.runJob).toHaveBeenCalledWith(
      'cae.simulation.start',
      expect.objectContaining({ measurement: expect.any(Object) }),
      expect.objectContaining({ autoFinish: false, slaveAppId: 'cae' }),
    )
    expect(sdk.clientOptions).toHaveBeenCalledWith({
      apiBaseUrl: '/api',
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    })
    expect(Object.keys(sdk.runJob.mock.calls[0][1])).toEqual(['formatVersion', 'measurement', 'solverContracts'])
    expect(sdk.runJob.mock.calls[0][2].attachments).toEqual([])
    const startPayload = sdk.runJob.mock.calls[0][1]
    expect(startPayload.formatVersion).toBe(2)
    expect(startPayload.solverContracts).toEqual([
      {
        name: 'dc-current-density',
        version: '0.1.0',
        contractDigest: 'd'.repeat(64),
      },
    ])
    expect(startPayload.measurement.experiment.scene.lengthUnit).toBe('mm')
    expect(startPayload.measurement.materialParameters.materials.Copper['electrical.conductivity'].value).toMatchObject(
      {
        dtype: 'float64',
        unit: 'S.cm-1',
        value: [
          [2, 0, 0],
          [0, 2, 0],
          [0, 0, 2],
        ],
      },
    )
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      { runId: 'run-1', ackSequence: null },
      { runId: 'run-1', ackSequence: 1 },
    ])
    expect(onRecord).toHaveBeenCalledOnce()
    expect(Object.keys(result)).toEqual(['values'])
    expect(createDataTensorAccessor(fixture.recordedData.values, result.values).materialize()).toEqual([1.25, 2.5])
    expect(finish).toHaveBeenCalledOnce()
    expect(activities.map(({ source, phase }) => `${source}:${phase}`)).toEqual([
      'gpstation:job.requested',
      'gpstation:job.connected',
      'cae:run.started',
      'cae:record.received',
      'cae:run.completed',
      'gpstation:job.finished',
    ])
    expect(activities.find(({ phase }) => phase === 'run.started')).toMatchObject({
      jobId: 'job-1',
      runId: 'run-1',
    })

    releaseRecordedDataAttachments(result)
  })

  it('finishes transport and rejects a simulation domain failure', async () => {
    const fixture = measurementFixture()
    const finish = vi.fn().mockResolvedValue(undefined)
    sdk.runJob.mockResolvedValue({
      payload: { kind: 'started', runId: 'run-2', maxRunSeconds: 10 },
      files: [],
      session: {
        call: vi.fn().mockResolvedValue({
          payload: {
            kind: 'failed',
            sequence: 1,
            error: { code: 'solver_convergence', message: '수렴하지 않았습니다.' },
          },
          files: [],
        }),
        finish,
        close: vi.fn(),
        jobId: 'job-2',
        closed: false,
      },
    })

    await expect(simulate(fixture.measurement as never)).rejects.toMatchObject({
      code: 'solver_convergence',
      message: '수렴하지 않았습니다.',
    })
    expect(finish).toHaveBeenCalledOnce()
  })

  it('reports normalized CAE status and progress activity without adding fields to the wire calls', async () => {
    const fixture = measurementFixture()
    const onActivity = vi.fn()
    const onProgress = vi.fn()
    const call = vi.fn(async (_handler: string, _payload: unknown, options: { onEvent: (event: unknown) => void }) => {
      options.onEvent({ type: 'status', payload: { status: 'running' } })
      options.onEvent({
        type: 'progress',
        payload: {
          task: 'electric',
          kernel: { name: 'dc-current-density', version: '0.1.0' },
          stage: 'solve',
          completed: 3,
          total: 4,
        },
      })
      options.onEvent({
        type: 'progress',
        payload: {
          task: 'electric',
          kernel: { name: 'dc-current-density', version: '0.1.0' },
          stage: 'output',
          completed: 1,
          total: 2,
        },
      })
      options.onEvent({
        type: 'progress',
        payload: {
          task: 'thermal',
          kernel: { name: 'steady-state-heat', version: '0.1.0' },
          stage: 'solve',
          completed: 1,
          total: 4,
        },
      })
      return { payload: { kind: 'complete', sequence: 1, recordSequences: [] }, files: [] }
    })
    sdk.runJob.mockResolvedValue({
      payload: { kind: 'started', runId: 'run-progress', maxRunSeconds: 60 },
      files: [],
      session: { call, finish: vi.fn(), close: vi.fn(), jobId: 'job-progress', closed: false },
    })

    await simulate(fixture.measurement as never, { onActivity, onProgress })

    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 3, total: 4, stage: 'solve' }))
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'cae',
        id: 'cae-progress:run-progress:electric',
        phase: 'run.progress',
        jobId: 'job-progress',
        runId: 'run-progress',
        progress: 0.75,
      }),
    )
    expect(
      onActivity.mock.calls
        .map(([activity]) => activity)
        .filter((activity) => activity.phase === 'run.progress')
        .map((activity) => activity.id),
    ).toEqual([
      'cae-progress:run-progress:electric',
      'cae-progress:run-progress:electric',
      'cae-progress:run-progress:thermal',
    ])
    expect(
      onActivity.mock.calls.map(([activity]) => activity).find((activity) => activity.phase === 'run.completed'),
    ).not.toHaveProperty('progress')
    expect(call.mock.calls[0]?.[1]).toEqual({ runId: 'run-progress', ackSequence: null })
  })

  it('reports scalar transport diagnostics without exposing SDP and retains the last failure state', async () => {
    const fixture = measurementFixture()
    const activities: RuntimeActivityDraft[] = []
    sdk.runJob.mockImplementation(async (_type, _payload, options) => {
      options.onJobCreated({ id: 'job-transport' })
      options.onDiagnostic({
        stage: 'job-result',
        message: 'received job result',
        callId: 'call-2',
        attachmentCount: 2,
        attachmentBytes: 4096,
        bufferedAmount: 0,
        connectionState: 'connected',
        dataChannelState: 'open',
        localCandidateSummary: { total: 2, host: 1, srflx: 1, relay: 0, prflx: 0, unknown: 0 },
        localSdp: 'secret-local-sdp',
        remoteSdp: 'secret-remote-sdp',
      })
      options.onDiagnostic({
        stage: 'data-channel-state',
        message: 'data channel state: error',
        bufferedAmount: 17,
        connectionState: 'failed',
        iceConnectionState: 'disconnected',
        dataChannelState: 'open',
      })
      throw new Error('data channel error')
    })

    await expect(
      simulate(fixture.measurement as never, { onActivity: (activity) => activities.push(activity) }),
    ).rejects.toThrow('data channel error')

    const received = activities.find(({ phase }) => phase === 'transport.job-result')
    expect(received).toMatchObject({
      source: 'gpstation',
      level: 'info',
      jobId: 'job-transport',
      details: {
        callId: 'call-2',
        attachmentCount: 2,
        attachmentBytes: 4096,
        bufferedAmount: 0,
        localCandidateTotal: 2,
        localCandidateHost: 1,
        localCandidateSrflx: 1,
      },
    })
    expect(received?.details).not.toHaveProperty('localSdp')
    expect(received?.details).not.toHaveProperty('remoteSdp')
    expect(activities.find(({ phase }) => phase === 'transport.data-channel-state')).toMatchObject({
      source: 'gpstation',
      level: 'error',
      details: { bufferedAmount: 17, connectionState: 'failed', dataChannelState: 'open' },
    })
    expect(activities.find(({ phase }) => phase === 'client.failed')).toMatchObject({
      details: {
        errorName: 'Error',
        lastTransportStage: 'data-channel-state',
        lastConnectionState: 'failed',
        lastIceConnectionState: 'disconnected',
        lastDataChannelState: 'open',
        lastBufferedAmount: 17,
      },
    })
  })

  it('rejects a taskless local manifest before opening a remote CAE session', async () => {
    const fixture = measurementFixture()
    const measurement = {
      ...fixture.measurement,
      experiment: {
        ...fixture.measurement.experiment,
        taskScenes: {},
        simulationProgram: { ...fixture.measurement.experiment.simulationProgram, tasks: {} },
      },
      taskMaterialParameters: {},
      taskMaterialWarnings: {},
    }

    await expect(simulate(measurement as never)).rejects.toMatchObject({ code: 'program_required' })
    expect(sdk.runJob).not.toHaveBeenCalled()
  })

  it('rejects preview-only render geometry at the CAE request boundary', async () => {
    const fixture = measurementFixture()
    const measurement = {
      ...fixture.measurement,
      experiment: {
        ...fixture.measurement.experiment,
        renderScene: { parts: [] },
      },
    }

    await expect(simulate(measurement as never)).rejects.toThrow('renderScene is not allowed')
    expect(sdk.runJob).not.toHaveBeenCalled()
  })

  it('moves a large UTF-8 start payload into request attachments', async () => {
    const fixture = measurementFixture()
    fixture.measurement.experiment.simulationProgram.pythonSource = `# ${'한'.repeat(300_000)}`
    sdk.runJob.mockResolvedValue({
      payload: { kind: 'started', runId: 'run-large-start', maxRunSeconds: 10 },
      files: [],
      session: {
        call: vi.fn().mockResolvedValue({
          payload: { kind: 'complete', sequence: 1, recordSequences: [] },
          files: [],
        }),
        finish: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        jobId: 'job-large-start',
        closed: false,
      },
    })

    await simulate(fixture.measurement as never)

    expect(sdk.runJob.mock.calls[0][1]).toMatchObject({
      kind: 'cae.start.payload-attachments',
      storage: { kind: 'attachments', byteLength: expect.any(Number) },
    })
    const attachments = sdk.runJob.mock.calls[0][2].attachments
    expect(attachments.at(-1)).toMatchObject({ mimeType: 'application/json; charset=utf-8' })
    const payload = JSON.parse(
      await readBlobText(
        attachments.find((item: { mimeType: string }) => item.mimeType.startsWith('application/json')).blob,
      ),
    )
    expect(Object.keys(payload)).toEqual(['formatVersion', 'measurement', 'solverContracts'])
  })

  it('keeps exactly 32 KiB inline and moves the next byte into request attachments', () => {
    const fixture = measurementFixture()
    const solverContracts = [
      {
        name: 'dc-current-density',
        version: '0.1.0',
        contractDigest: 'd'.repeat(64),
      },
    ]
    const payload = () => ({ formatVersion: 2, measurement: fixture.measurement, solverContracts })
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode(JSON.stringify(payload())).byteLength
    fixture.measurement.experiment.simulationProgram.pythonSource += 'x'.repeat(32 * 1024 - baseBytes)

    expect(encoder.encode(JSON.stringify(payload()))).toHaveLength(32 * 1024)
    expect(serializeCaeRequest(fixture.measurement as never, solverContracts).attachments).toEqual([])

    fixture.measurement.experiment.simulationProgram.pythonSource += 'x'
    const sharded = serializeCaeRequest(fixture.measurement as never, solverContracts)
    expect(sharded.payload).toMatchObject({
      kind: 'cae.start.payload-attachments',
      storage: { kind: 'attachments', byteLength: 32 * 1024 + 1 },
    })
    expect(sharded.attachments).toHaveLength(1)
    expect(sharded.attachments[0]).toMatchObject({ mimeType: 'application/json; charset=utf-8' })
  })

  it('rejects malformed or obsolete terminal payload fields', async () => {
    const fixture = measurementFixture()
    sdk.runJob.mockResolvedValue({
      payload: { kind: 'started', runId: 'run-malformed', maxRunSeconds: 10 },
      files: [],
      session: {
        call: vi.fn().mockResolvedValue({
          payload: {
            kind: 'complete',
            sequence: 1,
            recordSequences: [],
            trace: [],
          },
          files: [],
        }),
        finish: vi.fn(),
        close: vi.fn(),
        jobId: 'job-malformed',
        closed: false,
      },
    })

    await expect(simulate(fixture.measurement as never)).rejects.toMatchObject({
      code: 'protocol_error',
    })
  })

  it('uses AbortSignal to kill and close an active session', async () => {
    const fixture = measurementFixture()
    const controller = new AbortController()
    const close = vi.fn()
    const call = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Simulation run was cancelled.', 'AbortError')),
            { once: true },
          )
          queueMicrotask(() => controller.abort())
        }),
    )
    sdk.runJob.mockImplementation(async (_type, _payload, options) => {
      options.onJobCreated({ id: 'job-cancel' })
      return {
        payload: { kind: 'started', runId: 'run-cancel', maxRunSeconds: 10 },
        files: [],
        session: { call, finish: vi.fn(), close, jobId: 'job-cancel', closed: false },
      }
    })
    await expect(
      simulate(fixture.measurement as never, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalled()
    expect(api.request).toHaveBeenCalledWith('post', '/web/jobs/job-cancel/kill')
  })
})
