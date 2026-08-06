// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataTensorAccessor } from '../cad'
import { releaseRecordedDataAttachments, runRemoteCaeSimulation } from './remoteCae'

const sdk = vi.hoisted(() => ({ listLaunchers: vi.fn(), runJob: vi.fn() }))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = sdk.listLaunchers
    runJob = sdk.runJob
  },
}))

function realization() {
  const recordedData = {
    values: {
      dtype: 'float64' as const,
      unit: '{fraction}' as const,
      quantityKind: 'DimensionlessRatio' as const,
      axes: [{ length: 2 }],
    },
  }
  const scene = {
    sceneHash: 'scene',
    lengthUnit: 'm',
    parts: [
      {
        id: 'part',
        geometry: {
          kind: 'mesh',
          positions: new Float64Array([0, 0, 0]),
          polygonOffsets: new Uint32Array([0, 1]),
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
      materialParameters: { schemaVersion: 1, materials: {} },
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
          formatVersion: 2,
          simulationApiVersion: 1,
          programHash: 'b'.repeat(64),
          pythonSource: 'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
          pythonSourceHash: 'd'.repeat(64),
          tasks: {},
          recordedData,
          recordedDataSchemaHash: '1234abcd',
        },
      },
      materialParameters: { schemaVersion: 1, materials: {} },
      materialWarnings: [],
    },
    recordedData,
  }
}

describe('remote CAE session adapter', () => {
  beforeEach(() => {
    sdk.runJob.mockReset()
    sdk.listLaunchers.mockReset()
    sdk.listLaunchers.mockResolvedValue([
      { id: 'launcher-1', status: 'ready', slave_app_ids: ['cae'] },
    ])
  })

  it('keeps one next outstanding, validates Blob bytes, then ACKs the record', async () => {
    const fixture = realization()
    ;(fixture.setup.experiment.simulationProgram.tasks as Record<string, unknown>).thermal = {
      kernel: { name: 'steady-state-heat', version: '0.0.0', descriptorHash: 'a955fbb5' },
      descriptor: null,
      config: {},
      configHash: 'abcd',
      outputArtifacts: {},
    }
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
            blob: {
              arrayBuffer: async () => bytes,
            } as Blob,
          },
        ],
      })
      .mockResolvedValueOnce({
        payload: {
          kind: 'complete',
          sequence: 2,
          recordSequences: [1],
          trace: [
            {
              task: 'thermal',
              kernel: { name: 'steady-state-heat', version: '0.0.0', descriptorHash: 'a955fbb5' },
              inputStateRevision: 0,
              outputStateRevision: 0,
              inputArtifacts: {
                heatSource: { id: 'artifact-1', artifactType: 'caemble.dc/joule-heating@1' },
              },
              status: 'succeeded',
              startedAt: 1,
              finishedAt: 2,
              durationMs: 1,
              observations: {},
            },
          ],
          provenance: {
            programHash: fixture.setup.experiment.simulationProgram.programHash,
            recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
            simulationApiVersion: 1,
            durationMs: 1,
          },
          finalStateRevision: 0,
          finalState: null,
        },
        files: [],
      })
    const finish = vi.fn().mockResolvedValue(undefined)
    sdk.runJob.mockImplementation(async () => {
      return {
        payload: {
          kind: 'started',
          runId: 'run-1',
          programHash: fixture.setup.experiment.simulationProgram.programHash,
          recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
          maxRunSeconds: 7200,
        },
        files: [],
        session: { call, finish, close: vi.fn(), jobId: 'job-1', closed: false },
      }
    })
    const onRecord = vi.fn()

    const result = await runRemoteCaeSimulation({
      apiBaseUrl: 'http://gpstation.test',
      token: 'gpsk_test',
      sample: fixture.sample as never,
      setup: fixture.setup as never,
      callbacks: { onRecord },
    }).promise

    expect(sdk.runJob).toHaveBeenCalledWith(
      'cae.simulation.start',
      expect.anything(),
      expect.objectContaining({ autoFinish: false, slaveAppId: 'cae' }),
    )
    expect(sdk.listLaunchers).toHaveBeenCalledOnce()
    const startOptions = sdk.runJob.mock.calls[0][2]
    expect(startOptions.attachments).toHaveLength(4)
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      { runId: 'run-1', ackSequence: null },
      { runId: 'run-1', ackSequence: 1 },
    ])
    expect(onRecord).toHaveBeenCalledOnce()
    const accessor = createDataTensorAccessor(fixture.recordedData.values, result.recordedData.values.data)
    expect(accessor.materialize()).toEqual([1.25, 2.5])
    expect(result.trace[0]).toMatchObject({
      inputStateRevision: 0,
      outputStateRevision: 0,
      inputArtifacts: {
        heatSource: { id: 'artifact-1', artifactType: 'caemble.dc/joule-heating@1' },
      },
    })
    expect(result.finalStateRevision).toBe(0)
    expect(finish).toHaveBeenCalledOnce()

    releaseRecordedDataAttachments({ values: result.recordedData.values.data })
  })

  it('treats a simulation failed payload as a domain error after finishing transport', async () => {
    const fixture = realization()
    const finish = vi.fn().mockResolvedValue(undefined)
    sdk.runJob.mockResolvedValue({
      payload: {
        kind: 'started',
        runId: 'run-2',
        programHash: fixture.setup.experiment.simulationProgram.programHash,
        recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
        maxRunSeconds: 10,
      },
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
      runRemoteCaeSimulation({
        apiBaseUrl: 'http://gpstation.test',
        token: 'gpsk_test',
        sample: fixture.sample as never,
        setup: fixture.setup as never,
      }).promise,
    ).rejects.toMatchObject({ code: 'solver_convergence', message: '수렴하지 않았습니다.' })
    expect(finish).toHaveBeenCalledOnce()
  })

  it('moves a large start JSON payload into 16 MiB request attachments', async () => {
    const fixture = realization()
    fixture.setup.experiment.simulationProgram.pythonSource = `# ${'한'.repeat(300_000)}`
    const call = vi.fn().mockResolvedValue({
      payload: {
        kind: 'complete',
        sequence: 1,
        recordSequences: [],
        trace: [],
        provenance: {
          programHash: fixture.setup.experiment.simulationProgram.programHash,
          recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
          simulationApiVersion: 1,
          durationMs: 1,
        },
        finalStateRevision: 0,
        finalState: null,
      },
      files: [],
    })
    sdk.runJob.mockResolvedValue({
      payload: {
        kind: 'started',
        runId: 'run-large-start',
        programHash: fixture.setup.experiment.simulationProgram.programHash,
        recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
        maxRunSeconds: 10,
      },
      files: [],
      session: {
        call,
        finish: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        jobId: 'job-large-start',
        closed: false,
      },
    })

    await runRemoteCaeSimulation({
      apiBaseUrl: 'http://gpstation.test',
      token: 'gpsk_test',
      sample: fixture.sample as never,
      setup: fixture.setup as never,
    }).promise

    expect(sdk.runJob.mock.calls[0][1]).toMatchObject({
      kind: 'cae.start.payload-attachments',
      storage: { kind: 'attachments', byteLength: expect.any(Number) },
    })
    const options = sdk.runJob.mock.calls[0][2]
    expect(options.attachments).toHaveLength(5)
    expect(options.attachments.at(-1)).toMatchObject({
      mimeType: 'application/json; charset=utf-8',
    })
    expect(options.attachments.at(-1).blob.size).toBeGreaterThan(512 * 1024)
  })

  it('rejects malformed failed payloads instead of trusting wire types', async () => {
    const fixture = realization()
    sdk.runJob.mockResolvedValue({
      payload: {
        kind: 'started',
        runId: 'run-malformed',
        programHash: fixture.setup.experiment.simulationProgram.programHash,
        recordedDataSchemaHash: fixture.setup.experiment.simulationProgram.recordedDataSchemaHash,
        maxRunSeconds: 10,
      },
      files: [],
      session: {
        call: vi.fn().mockResolvedValue({
          payload: {
            kind: 'failed',
            sequence: 1,
            error: { code: 42, message: '' },
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
      runRemoteCaeSimulation({
        apiBaseUrl: 'http://gpstation.test',
        token: 'gpsk_test',
        sample: fixture.sample as never,
        setup: fixture.setup as never,
      }).promise,
    ).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('rejects malformed terminal trace instead of inventing task and kernel provenance', async () => {
    const fixture = realization()
    const manifest = fixture.setup.experiment.simulationProgram
    ;(manifest.tasks as Record<string, unknown>).electric = {
      kernel: { name: 'dc-current-density', version: '0.0.0', descriptorHash: 'abcd' },
      descriptor: null,
      config: {},
      configHash: 'abcd',
      outputArtifacts: {},
    }
    sdk.runJob.mockResolvedValue({
      payload: {
        kind: 'started',
        runId: 'run-trace',
        programHash: manifest.programHash,
        recordedDataSchemaHash: manifest.recordedDataSchemaHash,
        maxRunSeconds: 10,
      },
      files: [],
      session: {
        call: vi.fn().mockResolvedValue({
          payload: {
            kind: 'complete',
            sequence: 1,
            recordSequences: [],
            trace: [
              {
                task: '',
                kernel: { name: 'cae', version: '1', descriptorHash: 'wrong' },
                inputStateRevision: 0,
                outputStateRevision: 0,
                inputArtifacts: {},
                status: 'succeeded',
                startedAt: 1,
                finishedAt: 2,
                durationMs: 1,
                observations: {},
              },
            ],
            provenance: {
              programHash: manifest.programHash,
              recordedDataSchemaHash: manifest.recordedDataSchemaHash,
              simulationApiVersion: 1,
              durationMs: 1,
            },
            finalStateRevision: 0,
            finalState: null,
          },
          files: [],
        }),
        finish: vi.fn(),
        close: vi.fn(),
        jobId: 'job-trace',
        closed: false,
      },
    })

    await expect(
      runRemoteCaeSimulation({
        apiBaseUrl: 'http://gpstation.test',
        token: 'gpsk_test',
        sample: fixture.sample as never,
        setup: fixture.setup as never,
      }).promise,
    ).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('rechecks cae launcher availability immediately before starting a run', async () => {
    const fixture = realization()
    sdk.listLaunchers.mockResolvedValue([
      { id: 'launcher-1', status: 'disconnected', slave_app_ids: ['cae'] },
    ])

    await expect(
      runRemoteCaeSimulation({
        apiBaseUrl: 'http://gpstation.test',
        token: 'gpsk_test',
        sample: fixture.sample as never,
        setup: fixture.setup as never,
      }).promise,
    ).rejects.toMatchObject({ code: 'cae_launcher_unavailable' })
    expect(sdk.runJob).not.toHaveBeenCalled()
  })
})
