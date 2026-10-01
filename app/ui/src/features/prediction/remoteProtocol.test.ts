import { describe, expect, it } from 'vitest'
import {
  parseRemoteEnvelope,
  profileJson,
  remoteHelloSchema,
  remoteProfileSchema,
  remoteResultSchema,
} from './remoteProtocol'

describe('Predictor Python wire contracts', () => {
  it('guides an old runner to the coordinated release update', () => {
    expect(() =>
      parseRemoteEnvelope({ protocolVersion: 1, requestId: 'request', sessionId: 'session' }, 'request'),
    ).toThrowError(/Predictor를 업데이트/)
  })

  it('reads unavailable artifact summaries emitted by ArtifactStore.list', () => {
    const hello = remoteHelloSchema.parse({
      sessionId: 'session',
      storageId: 'storage',
      launcherId: 'launcher',
      implementationVersion: 'knn-v1',
      preprocessingVersion: 'box-relative-v2',
      capabilities: {},
      datasets: [
        {
          datasetId: 'dataset',
          revision: 3,
          available: false,
          error: { code: 'artifact-missing', message: 'Dataset payload is missing.' },
        },
      ],
      models: [
        {
          modelId: 'model',
          revision: 2,
          available: false,
          error: { code: 'artifact-checksum', message: 'Saved file checksum differs from its manifest.' },
        },
      ],
    })
    expect(hello.datasets[0]).toEqual({
      datasetId: 'dataset',
      revision: 3,
      available: false,
      error: 'Dataset payload is missing.',
    })
    expect(hello.models[0]).toEqual({
      modelId: 'model',
      revision: 2,
      available: false,
      error: 'Saved file checksum differs from its manifest.',
    })
  })

  it('keeps retired Dataset receipts with their identity and provenance', () => {
    const receipt = {
      datasetId: 'dataset',
      revision: 1,
      fingerprint: 'old-content',
      sourceKind: 'local',
      payloadAvailable: false,
      origin: { datasetId: 'server-dataset', revision: 7 },
      sourceContracts: { sourceHash: 'source', records: [] },
    }
    const hello = remoteHelloSchema.parse({
      sessionId: 'session',
      storageId: 'storage',
      launcherId: 'launcher',
      implementationVersion: 'knn-v1',
      preprocessingVersion: 'box-relative-v2',
      capabilities: {},
      datasets: [receipt],
      models: [],
    })
    expect(hello.datasets).toEqual([receipt])
  })

  it('keeps request and process identity ahead of an application error', () => {
    const response = {
      protocolVersion: 2,
      requestId: 'previous-request',
      sessionId: 'old-process',
      error: { code: 'dataset-missing', message: 'Missing Dataset.' },
    }
    expect(() => parseRemoteEnvelope(response, 'new-request', 'current-process')).toThrowError(/이전 Prediction/)
    expect(() => parseRemoteEnvelope(response, 'previous-request', 'old-process')).toThrowError('Missing Dataset.')
  })

  it('converts only wire scaling arrays and preserves persisted numerical metadata', () => {
    const profile = {
      direction: 'inverse',
      rowCount: 2,
      inputLayouts: [],
      inputSize: 1,
      outputSize: 1,
      includedMeasurementIds: [1, 2],
      warningMeasurementIds: [],
      diagnostics: [],
      omittedDiagnosticGroups: 0,
      excluded: {
        'missing-block': 0,
        'extra-block': 0,
        'invalid-tensor': 0,
        'fixed-layout-mismatch': 0,
        'layout-mismatch': 0,
      },
      knn: {
        dominantShapeSignature: 'calculation',
        baselineMeasurementId: 1,
        k: 1,
        weighting: 'distance',
        inputScaling: 'standard-deviation',
        inputScales: [2.5],
        inputBlockWeights: { 'calculation:4': 1 },
        activeInputBlockCount: 1,
      },
    }
    const parsed = remoteProfileSchema.parse(profile)
    expect(parsed.knn!.inputScales).toBeInstanceOf(Float64Array)
    expect(profileJson(parsed)).toEqual(profile)
  })

  it('preserves Box Grid meaning while rejecting a result with missing tensor values', () => {
    const boxGrid = {
      version: 1,
      sampling: 'point',
      components: ['scalar'],
      channels: ['value'],
      channelUnits: ['K'],
      origin: [10, 20, 30],
      size: [2, 4, 6],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      gridShape: [1, 1, 1],
      lengthUnit: 'm',
      source: 'task',
      rootId: 'box',
      configuration: 'reference',
      weighting: 'material-volume',
    }
    const output = {
      layout: {
        key: 'temperature',
        dtype: 'float64',
        shape: [1, 1, 1, 1, 1, 1, 1],
        axes: ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component'].map((name) => ({ name, ticks: [0] })),
        unit: 'K',
        quantityKind: 'thermodynamics.Temperature',
        tensorOrder: 0,
        boxGrid,
      },
      values: [15],
    }
    const result = {
      direction: 'forward',
      fingerprint: 'model',
      output: [output],
      extrapolatedInputKeys: [],
      constantInputKeysChanged: [],
      queryDiagnostics: [],
      provenance: { modelId: 'model', modelRevision: 1, datasetId: 'dataset', datasetRevision: 2 },
    }
    expect(remoteResultSchema.parse(result).output[0].layout).toEqual(output.layout)
    expect(remoteResultSchema.safeParse({ ...result, output: [{ ...output, values: [] }] }).success).toBe(false)
  })
})
