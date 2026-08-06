// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataTensorAccessor } from '../../lib/cad'
import { releaseRecordedDataAttachments, simulate } from './client'

const sdk = vi.hoisted(() => ({ clientOptions: vi.fn(), listLaunchers: vi.fn(), runJob: vi.fn() }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    constructor(options: unknown) {
      sdk.clientOptions(options)
    }

    listLaunchers = sdk.listLaunchers
    runJob = sdk.runJob
  },
}))

const gpStationConnection = {
  api_base_url: 'https://gps.example.test',
  access_token: 'gpsk_test',
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

function realization() {
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
    sceneHash: 'c'.repeat(64),
    lengthUnit: 'mm',
    parts: [
      {
        id: 'part',
        geometry: {
          kind: 'mesh',
          positions: new Float64Array([1000, 0, 0]),
          polygonOffsets: new Uint32Array([0, 3]),
        },
        surfaces: [],
      },
    ],
    tree: { key: 'root', label: 'root', children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
  return {
    sample: {
      kind: 'sample',
      structure: {
        kind: 'structure',
        sourceHash: 'a'.repeat(64),
        seed: 1,
        variables: {},
        varsSchema: {},
        scene,
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
    },
    setup: {
      kind: 'setup',
      experiment: {
        kind: 'experiment',
        sourceHash: 'b'.repeat(64),
        seed: 2,
        variables: {},
        varsSchema: {},
        scene,
        simulationProgram: {
          formatVersion: 3,
          simulationApiVersion: 1,
          pythonSource: 'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
          tasks: {
            electric: {
              kernel: { name: 'dc-current-density', version: '0.0.0' },
              config: {},
            },
          },
          recordedData,
        },
      },
      materialParameters: { schemaVersion: 1, materials: {} },
      materialWarnings: [],
    },
    recordedData,
  }
}

describe('CAE session client', () => {
  beforeEach(() => {
    sdk.runJob.mockReset()
    sdk.listLaunchers.mockReset()
    sdk.clientOptions.mockReset()
    sdk.listLaunchers.mockResolvedValue([{ id: 'launcher-1', status: 'ready', slave_app_ids: ['cae'] }])
  })

  it('sends only sample/setup, ACKs one record at a time, and returns RecordedData only', async () => {
    const fixture = realization()
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

    const result = await simulate(fixture.sample as never, fixture.setup as never, {
      connection: gpStationConnection,
      onRecord,
    })

    expect(sdk.runJob).toHaveBeenCalledWith(
      'cae.simulation.start',
      expect.objectContaining({ sample: expect.any(Object), setup: expect.any(Object) }),
      expect.objectContaining({ autoFinish: false, slaveAppId: 'cae' }),
    )
    expect(Object.keys(sdk.runJob.mock.calls[0][1]).sort()).toEqual(['sample', 'setup'])
    const startPayload = sdk.runJob.mock.calls[0][1]
    expect(startPayload.sample.structure.scene.lengthUnit).toBe('m')
    expect(startPayload.sample.materialParameters.materials.Copper['electrical.conductivity'].value).toMatchObject({
      dtype: 'float64',
      unit: 'S.m-1',
      value: [
        [200, 0, 0],
        [0, 200, 0],
        [0, 0, 200],
      ],
    })
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      { runId: 'run-1', ackSequence: null },
      { runId: 'run-1', ackSequence: 1 },
    ])
    expect(onRecord).toHaveBeenCalledOnce()
    expect(Object.keys(result)).toEqual(['values'])
    expect(createDataTensorAccessor(fixture.recordedData.values, result.values).materialize()).toEqual([1.25, 2.5])
    expect(finish).toHaveBeenCalledOnce()
    expect(sdk.clientOptions).toHaveBeenCalledWith({
      apiBaseUrl: 'https://gps.example.test',
      token: 'gpsk_test',
    })

    releaseRecordedDataAttachments(result)
  })

  it('finishes transport and rejects a simulation domain failure', async () => {
    const fixture = realization()
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

    await expect(
      simulate(fixture.sample as never, fixture.setup as never, { connection: gpStationConnection }),
    ).rejects.toMatchObject({
      code: 'solver_convergence',
      message: '수렴하지 않았습니다.',
    })
    expect(finish).toHaveBeenCalledOnce()
  })

  it('moves a large UTF-8 start payload into request attachments', async () => {
    const fixture = realization()
    fixture.setup.experiment.simulationProgram.pythonSource = `# ${'한'.repeat(300_000)}`
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

    await simulate(fixture.sample as never, fixture.setup as never, { connection: gpStationConnection })

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
    expect(Object.keys(payload).sort()).toEqual(['sample', 'setup'])
  })

  it('rejects malformed or obsolete terminal payload fields', async () => {
    const fixture = realization()
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

    await expect(
      simulate(fixture.sample as never, fixture.setup as never, { connection: gpStationConnection }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
    })
  })

  it('uses AbortSignal to kill and close an active session', async () => {
    const fixture = realization()
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    await expect(
      simulate(fixture.sample as never, fixture.setup as never, {
        connection: gpStationConnection,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gps.example.test/v1/jobs/job-cancel/kill',
      expect.objectContaining({
        headers: { Authorization: 'Bearer gpsk_test' },
      }),
    )
    fetchMock.mockRestore()
  })

  it('blocks runs when no access token or connected CAE launcher exists', async () => {
    const fixture = realization()
    await expect(simulate(fixture.sample as never, fixture.setup as never)).rejects.toMatchObject({
      code: 'access_token_required',
    })

    sdk.listLaunchers.mockResolvedValue([{ id: 'launcher-1', status: 'disconnected', slave_app_ids: ['cae'] }])
    await expect(
      simulate(fixture.sample as never, fixture.setup as never, { connection: gpStationConnection }),
    ).rejects.toMatchObject({
      code: 'cae_launcher_unavailable',
    })
    expect(sdk.runJob).not.toHaveBeenCalled()
  })
})
