import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbTables, type PersistedMeasurementRecord, type PersistedRecordedDataRecord } from '@/api'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { PredictionContext } from './predictionContextData'
import { createTrainingSnapshot, loadTrainingSnapshot, type TrainingSnapshotInput } from './trainingSnapshot'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const origin: [number, number, number] = [0, 0, 0]
  const boxGrid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components: ['scalar'],
    channels: ['value'],
    channelUnits: ['K'],
    origin,
    size: [1, 1, 1],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    gridShape: [1, 1, 1],
    lengthUnit: 'm',
    source: 'experiment',
    rootId: 'box',
  }
  const values = [10]
  const row: PersistedRecordedDataRecord = {
    id: 11,
    measurement_id: 1,
    experiment_record_id: 7,
    name: 'temperature',
    quantity_kind: null,
    dtype: 'float64',
    tensor_order: 0,
    data: {
      shape: [1, 1, 1, 1, 1, 1, 1],
      boxGrid,
      axes: [{ ticks: [0.5] }],
      storage: { kind: 'inline', value: values },
    },
  }
  const varsSchema = { x: { shape: [] as number[], min: 0, max: 10 } }
  const measurement = {
    id: 1,
    experiment_id: 3,
    vars: { x: 2 },
    recorded_at: '2026-01-01',
    calculation_data_count: 1,
    material_snapshot: {} as PersistedMeasurementRecord['material_snapshot'],
  }
  const record = {
    id: 7,
    experiment_id: 3,
    name: 'temperature',
    quantity_kind: null,
    dtype: 'float64',
    tensor_order: 0,
    contract_hash: 'contract-v1',
  }
  const calculation = {
    id: 9,
    source_id: 9,
    revision: 1,
    experiment_id: 3,
    name: 'maximum',
    source_code: 'return 1',
    contract_status: 'ready' as const,
    experiment_record_ids: [7],
    calculation_data_count: 1,
    recorded_measurement_count: 1,
    measurement_count: 1,
  }
  const context: PredictionContext = {
    experimentId: 3,
    fingerprint: 'source-v1',
    measurements: [measurement],
    experimentRecords: [record],
    calculations: [calculation],
    analysis: {
      fingerprint: 'analysis-v1',
      total: 1,
      measurement_count: 1,
      items: [
        {
          calculation_data_id: 21,
          calculation_id: 9,
          calculation_name: 'maximum',
          measurement_id: 1,
          dtype: 'float64',
          summary: { kind: 'scalar', value: 10 },
        },
      ],
    },
  }
  const input = {
    experimentId: 3,
    sourceFingerprint: context.fingerprint,
    direction: 'forward' as const,
    measurements: [measurement],
    varsSchema,
    records: [record],
    recorded: [row],
    rules: [],
    resultContracts: {},
  } satisfies TrainingSnapshotInput
  return { input, row, boxGrid, origin, values, varsSchema, measurement, context }
}

describe('Prediction training snapshots', () => {
  it('copies shared selection and owns freshly fetched data without copying tensor arrays', async () => {
    const source = fixture()
    const pending = createTrainingSnapshot(source.input)
    source.measurement.vars.x = 8
    source.varsSchema.x.max = 20
    expect(() => source.values.push(20)).toThrow()
    expect(() => (source.origin[0] = 8)).toThrow()
    const snapshot = await pending
    expect(snapshot.measurements[0].vars.x).toBe(2)
    expect(snapshot.varsSchema.x.max).toBe(10)
    expect(snapshot.direction).toBe('forward')
    if (snapshot.direction !== 'forward') throw new Error('Expected forward snapshot')
    expect(snapshot.recorded).toBe(source.input.recorded)
    expect(snapshot.recorded[0].data).toBe(source.row.data)
    expect(snapshot.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('hashes canonical content independent of object insertion order and freshness token', async () => {
    const original = fixture()
    const reordered = fixture()
    reordered.input.sourceFingerprint = 'new-context-token'
    reordered.varsSchema.x = { max: 10, min: 0, shape: [] }
    reordered.input.recorded = [
      {
        ...reordered.row,
        data: {
          storage: { value: [10], kind: 'inline' },
          axes: [{ ticks: [0.5] }],
          boxGrid: reordered.boxGrid,
          shape: [1, 1, 1, 1, 1, 1, 1],
        },
      },
    ]
    expect((await createTrainingSnapshot(original.input)).fingerprint).toBe(
      (await createTrainingSnapshot(reordered.input)).fingerprint,
    )
  })

  it('changes identity for values or per-row coordinates without rejecting different grids', async () => {
    const original = fixture()
    const changedValue = fixture()
    changedValue.values[0] = 30
    const changedGrid = fixture()
    changedGrid.origin[0] = 4
    const snapshots = await Promise.all(
      [original.input, changedValue.input, changedGrid.input].map(createTrainingSnapshot),
    )
    expect(new Set(snapshots.map((snapshot) => snapshot.fingerprint)).size).toBe(3)
    const together = fixture()
    together.input.recorded.push({ ...changedGrid.row, id: 12, measurement_id: 2 })
    await expect(createTrainingSnapshot(together.input)).resolves.toMatchObject({ direction: 'forward' })
  })

  it('pins unresolved object references and includes their checksums in identity', async () => {
    const original = fixture()
    const reference = {
      kind: 'caemble.object',
      version: 1,
      id: 'object-1',
      sha256: 'a'.repeat(64),
      byteLength: 200,
      encoding: 'json',
    }
    original.input.recorded = [{ ...original.row, data: { storage: { kind: 'inline', value: reference } } }]
    const changed = fixture()
    changed.input.recorded = [
      { ...changed.row, data: { storage: { kind: 'inline', value: { ...reference, sha256: 'b'.repeat(64) } } } },
    ]
    const first = await createTrainingSnapshot(original.input)
    const second = await createTrainingSnapshot(changed.input)
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(Object.isFrozen(reference)).toBe(true)
  })

  it('captures selection before fetching and applies the selected implementation policy to raw rows', async () => {
    const source = fixture()
    let finish!: (value: { total: number; items: PersistedRecordedDataRecord[] }) => void
    const fetchRows = vi.spyOn(dbTables.RecordedData, 'listRows').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const checkRecordedData = vi.fn()
    const checkFreshness = vi.fn().mockResolvedValue('source-v1')
    const pending = loadTrainingSnapshot({
      context: source.context,
      experimentId: 3,
      direction: 'forward',
      varsSchema: source.varsSchema,
      requiredRecordIds: [7],
      policy: { checkRecordedData, checkCalculationData: vi.fn() },
      checkFreshness,
    })
    source.measurement.vars.x = 8
    source.varsSchema.x.max = 20
    ;(source.context.experimentRecords[0] as { id: number }).id = 99
    finish({ total: 1, items: [source.row] })
    const snapshot = await pending
    expect(snapshot.measurements[0].vars.x).toBe(2)
    expect(snapshot.varsSchema.x.max).toBe(10)
    expect(snapshot.direction === 'forward' && snapshot.recorded).toHaveLength(1)
    expect(fetchRows.mock.calls[0][1]).toEqual({ signal: undefined, resolveObjects: false })
    expect(checkRecordedData).toHaveBeenCalledWith([source.row], { x: { shape: [], min: 0, max: 10 } })
    expect(checkFreshness).toHaveBeenCalledOnce()
  })

  it('rejects source drift and cancellation before publishing a snapshot', async () => {
    const source = fixture()
    vi.spyOn(dbTables.RecordedData, 'listRows').mockResolvedValue({ total: 1, items: [source.row] })
    await expect(
      loadTrainingSnapshot({
        context: source.context,
        experimentId: 3,
        direction: 'forward',
        varsSchema: source.varsSchema,
        requiredRecordIds: [7],
        checkFreshness: async () => 'source-v2',
      }),
    ).rejects.toThrow('원본이 변경')
    const controller = new AbortController()
    await expect(
      loadTrainingSnapshot({
        context: source.context,
        experimentId: 3,
        direction: 'forward',
        varsSchema: source.varsSchema,
        requiredRecordIds: [7],
        signal: controller.signal,
        checkFreshness: async () => {
          controller.abort()
          return 'source-v1'
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('loads hydrated inverse batches and stops before another batch when the execution policy rejects', async () => {
    const source = fixture()
    const context = {
      ...source.context,
      analysis: {
        ...source.context.analysis,
        items: Array.from({ length: 51 }, (_, index) => ({
          ...source.context.analysis.items[0],
          calculation_data_id: index + 21,
        })),
      },
    }
    const data = {
      id: 21,
      calculation_id: 9,
      measurement_id: 1,
      data: { dtype: 'float64' as const, shape: [], axes: [], data: 10 },
    }
    const fetchRows = vi.spyOn(dbTables.CalculationData, 'listRows').mockResolvedValue({ total: 1, items: [data] })
    const options = {
      context,
      experimentId: 3,
      direction: 'inverse' as const,
      varsSchema: source.varsSchema,
      calculationIds: [9],
    }
    const checkCalculationData = vi.fn(() => {
      throw new Error('execution capacity exceeded')
    })
    await expect(
      loadTrainingSnapshot({ ...options, policy: { checkRecordedData: vi.fn(), checkCalculationData } }),
    ).rejects.toThrow('execution capacity exceeded')
    expect(fetchRows).toHaveBeenCalledOnce()
    expect(fetchRows.mock.calls[0][1]).toEqual({ signal: undefined })
    expect(Object.isFrozen(data.data)).toBe(true)
    fetchRows.mockClear()
    const snapshot = await loadTrainingSnapshot(options)
    expect(snapshot.direction).toBe('inverse')
    expect(fetchRows).toHaveBeenCalledTimes(2)
    expect(snapshot.direction === 'inverse' && snapshot.calculationData[0].data.data).toBe(10)
  })
})
