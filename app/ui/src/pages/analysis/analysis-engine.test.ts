import { describe, expect, it } from 'vitest'
import type { MeasurementRecord, RecordedDataRecord } from '@/api'
import {
  buildAnalysisDataset,
  collectAnalysisQuantityKindNames,
  createCsv,
  createMeasurementRanges,
  getTablePage,
  mineDataset,
  predictDataset,
} from './analysis-engine'

const scalarQuantityKinds = new Map([['Dimensionless', 0]])

function createDataset(targetValue = (width: number, voltage: number) => width * 3 + voltage * 2) {
  const measurements: MeasurementRecord[] = []
  const recordedData: RecordedDataRecord[] = []
  Array.from({ length: 5 }, (_, widthIndex) => widthIndex + 1).forEach((width) => {
    Array.from({ length: 6 }, (_, voltageIndex) => voltageIndex + 0.5).forEach((voltage) => {
      const id = measurements.length + 1_000
      measurements.push({
        id,
        experiment_id: 22,
        vars: { width, voltage, nested: { offset: (width - 1) * 0.25 } },
        material_parameters: {
          schemaVersion: 2,
          experiment: { schemaVersion: 1, materials: {} },
          tasks: { main: { schemaVersion: 1, materials: {} } },
        },
        recorded_at: '2026-08-12T00:00:00Z',
      })
      const response = targetValue(width, voltage)
      const responseBytes = new Uint8Array(8)
      new DataView(responseBytes.buffer).setFloat64(0, response, true)
      recordedData.push({
        id: id + 10_000,
        measurement_id: id,
        name: 'response',
        dtype: 'float64',
        quantity_kind: 'Dimensionless',
        tensor_order: 0,
        data_schema: {
          dtype: 'float64',
          unit: '1',
          quantityKind: 'Dimensionless',
        },
        data:
          id % 2 === 0
            ? { value: response }
            : {
                tensorEncodingVersion: 1,
                shape: [],
                storage: {
                  kind: 'base64',
                  data: btoa(String.fromCharCode(...responseBytes)),
                  byteLength: responseBytes.byteLength,
                },
              },
      })
      recordedData.push({
        id: id + 20_000,
        measurement_id: id,
        name: 'state',
        dtype: 'string',
        quantity_kind: null,
        tensor_order: 0,
        data_schema: { dtype: 'string' },
        data:
          id % 2 === 0
            ? { value: width > 2 ? 'wide' : 'narrow' }
            : {
                tensorEncodingVersion: 1,
                shape: [],
                storage: { kind: 'inline', value: width > 2 ? 'wide' : 'narrow' },
              },
      })
    })
  })
  return buildAnalysisDataset({
    experimentId: 22,
    fingerprint: 'fixture',
    measurements,
    quantityKindTensorOrders: scalarQuantityKinds,
    recordedData,
  })
}

describe('Analysis engine', () => {
  it('Measurement ID를 500개·폭 2,000 이하의 정확한 범위로 묶는다', () => {
    const ids = [1, 2, 2, 2_001, 2_002, 4_100, ...Array.from({ length: 501 }, (_, index) => 10_000 + index)]
    const ranges = createMeasurementRanges(ids)

    expect(ranges.flatMap((range) => range.ids)).toEqual([...new Set(ids)].sort((left, right) => left - right))
    expect(ranges.every((range) => range.ids.length <= 500)).toBe(true)
    expect(ranges.every((range) => range.max - range.min <= 2_000)).toBe(true)
  })

  it('저장된 Material과 Recorded Data에서 필요한 QuantityKind 이름만 수집한다', () => {
    const measurements = [
      {
        id: 1,
        experiment_id: 22,
        vars: { quantityKind: '사용자 변수는 무시' },
        material_parameters: {
          schemaVersion: 2,
          experiment: {
            schemaVersion: 1,
            materials: {
              Copper: {
                density: { value: { quantityKind: 'test.MaterialScalar', unit: '{test-material}', value: 1 } },
              },
            },
          },
          tasks: {},
        },
        recorded_at: null,
      },
    ] satisfies MeasurementRecord[]
    const recordedData = [
      {
        id: 2,
        measurement_id: 1,
        name: 'field',
        dtype: 'float64',
        quantity_kind: 'test.RecordedVector',
        tensor_order: 1,
        data_schema: {
          dtype: 'float64',
          quantityKind: 'test.RecordedVector',
          unit: '{test-vector}',
          axes: [{ name: 'position', quantityKind: 'test.Axis', unit: '{test-axis}' }],
        },
        data: { value: [] },
      },
    ] satisfies RecordedDataRecord[]

    expect(collectAnalysisQuantityKindNames(measurements, recordedData)).toEqual([
      'test.Axis',
      'test.MaterialScalar',
      'test.RecordedVector',
    ])
  })

  it('scalar profile과 categorical 빈도, 100행 이하 table page를 만든다', () => {
    const dataset = createDataset()
    const response = dataset.profile.columns.find((column) => column.key === 'target:response')

    expect(dataset.profile).toMatchObject({
      rowCount: 30,
      preparedCount: 0,
      recordedMeasurementCount: 30,
      recordedDataCount: 60,
    })
    expect(response?.eligible).toBe(true)
    expect(response?.unit).toBe('1')
    expect(response?.histogram?.length).toBeGreaterThan(1)
    expect(dataset.profile.columns.some((column) => column.key.includes('metadata'))).toBe(false)
    expect(dataset.profile.categoricalSummaries[0]).toMatchObject({
      name: 'state',
      counts: expect.arrayContaining([
        { value: 'wide', count: 18 },
        { value: 'narrow', count: 12 },
      ]),
    })
    expect(getTablePage(dataset, ['measurement.vars.width', 'target:response'], 0, 1).rows).toHaveLength(1)
    expect(getTablePage(dataset, ['measurement.vars.width'], 0, 1_000).rows).toHaveLength(30)
  })

  it('v2 Measurement의 Experiment/Task Material을 입력 identity에 포함한다', () => {
    const base: MeasurementRecord = {
      id: 1,
      experiment_id: 22,
      vars: { width: 2 },
      material_parameters: {
        schemaVersion: 2,
        experiment: {
          schemaVersion: 1,
          materials: {
            Copper: {
              'thermal.conductivity': {
                value: { dtype: 'float64', quantityKind: 'ThermalConductivity', unit: 'W/(m.K)', value: 400 },
              },
            },
          },
        },
        tasks: {
          thermal: {
            schemaVersion: 1,
            materials: {
              Copper: {
                'general.mass_density': {
                  value: { dtype: 'float64', quantityKind: 'MassDensity', unit: 'kg/m3', value: 8960 },
                },
              },
            },
          },
        },
      },
      recorded_at: null,
    }
    const changedMaterial: MeasurementRecord = {
      ...base,
      id: 3,
      material_parameters: {
        ...base.material_parameters,
        experiment: {
          schemaVersion: 1,
          materials: {
            Copper: {
              'thermal.conductivity': {
                value: { dtype: 'float64', quantityKind: 'ThermalConductivity', unit: 'W/(m.K)', value: 401 },
              },
            },
          },
        },
      },
    }
    const dataset = buildAnalysisDataset({
      experimentId: 22,
      fingerprint: 'materials',
      measurements: [base, { ...base, id: 2 }, changedMaterial],
      recordedData: [],
    })

    expect(dataset.profile.columns.map((column) => column.key)).toEqual(
      expect.arrayContaining([
        'measurement.material.experiment.Copper.thermal.conductivity',
        'measurement.material.tasks.thermal.Copper.general.mass_density',
      ]),
    )
    expect(dataset.rows[0].inputFingerprint).toBe(dataset.rows[1].inputFingerprint)
    expect(dataset.rows[0].inputFingerprint).not.toBe(dataset.rows[2].inputFingerprint)
  })

  it('결과 기반 상관 분석에서 prepared Measurement를 제외한다', () => {
    const measurements: MeasurementRecord[] = [1, 2, 3, 100, 200].map((value, index) => ({
      id: index + 1,
      experiment_id: 22,
      vars: { x: value, y: value ** 2 },
      material_parameters: {
        schemaVersion: 2,
        experiment: { schemaVersion: 1, materials: {} },
        tasks: { main: { schemaVersion: 1, materials: {} } },
      },
      recorded_at: index < 3 ? '2026-08-12T00:00:00Z' : null,
    }))
    const recordedData: RecordedDataRecord[] = [1, 2, 3].map((value) => ({
      id: value,
      measurement_id: value,
      name: 'response',
      quantity_kind: null,
      tensor_order: 0,
      dtype: 'float64',
      data_schema: { dtype: 'float64' },
      data: { value },
    }))
    const dataset = buildAnalysisDataset({ experimentId: 22, fingerprint: 'recorded-only', measurements, recordedData })
    const result = mineDataset(dataset, {
      featureKeys: ['measurement.vars.x', 'measurement.vars.y'],
      targetKey: 'target:response',
      xKey: null,
      yKey: null,
      outlierFraction: 0.05,
    })

    expect(result.correlations[0][2]).toBeCloseTo(1)
    expect(result.spearmanCorrelations[0][2]).toBeCloseTo(1)
  })

  it('streams a large persisted DataTensor through its accessor without materializing the tensor', () => {
    const length = 100_000
    const bytes = new Uint8Array(length * 4)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < length; index += 1) view.setFloat32(index * 4, index, true)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)))
    }
    const dataset = buildAnalysisDataset({
      experimentId: 22,
      fingerprint: 'large-accessor',
      measurements: [
        {
          id: 1,
          experiment_id: 22,
          vars: {},
          material_parameters: {
            schemaVersion: 2,
            experiment: { schemaVersion: 1, materials: {} },
            tasks: { main: { schemaVersion: 1, materials: {} } },
          },
          recorded_at: '2026-08-12T00:00:00Z',
        },
      ],
      quantityKindTensorOrders: scalarQuantityKinds,
      recordedData: [
        {
          id: 2,
          measurement_id: 1,
          name: 'large',
          dtype: 'float32',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          data_schema: {
            dtype: 'float32',
            unit: '1',
            quantityKind: 'Dimensionless',
            axes: [{ name: 'index', length }],
          },
          data: {
            tensorEncodingVersion: 1,
            shape: [length],
            axes: [{ ticks: Array.from({ length }, (_, index) => index) }],
            storage: { kind: 'base64', data: btoa(binary), byteLength: bytes.byteLength },
          },
        },
      ],
    })

    expect(dataset.profile.columns.find((column) => column.key === 'target:large:mean')?.mean).toBeCloseTo(
      (length - 1) / 2,
      5,
    )
    expect(dataset.profile.columns.find((column) => column.key === 'target:large:min')?.mean).toBe(0)
    expect(dataset.profile.columns.find((column) => column.key === 'target:large:max')?.mean).toBe(length - 1)
  })

  it('seed 42로 PCA·K-Means·reconstruction anomaly를 재현한다', () => {
    const firstDataset = createDataset()
    const secondDataset = createDataset()
    const options = {
      featureKeys: ['measurement.vars.width', 'measurement.vars.nested.offset', 'measurement.vars.voltage'],
      outlierFraction: 0.05,
      targetKey: 'target:response',
      xKey: 'measurement.vars.width',
      yKey: 'target:response',
    }

    const first = mineDataset(firstDataset, options)
    const second = mineDataset(secondDataset, options)

    expect(first.clusterCount).toBe(second.clusterCount)
    expect(first.silhouette).toBeCloseTo(second.silhouette, 10)
    expect(first.points.map(({ cluster, anomalyScore, outlier }) => ({ cluster, anomalyScore, outlier }))).toEqual(
      second.points.map(({ cluster, anomalyScore, outlier }) => ({ cluster, anomalyScore, outlier })),
    )
    expect(first.points.filter((point) => point.outlier).length).toBeGreaterThan(0)
  })

  it('동일 Measurement 입력을 fold 사이에 섞지 않고 Ridge·Random Forest를 비교한다', () => {
    const dataset = createDataset()
    const result = predictDataset(dataset, {
      featureKeys: ['measurement.vars.width', 'measurement.vars.voltage'],
      targetKey: 'target:response',
      whatIf: { 'measurement.vars.width': 20, 'measurement.vars.voltage': 2 },
    })
    const foldsByInput = new Map<string, Set<number>>()
    result.rows.forEach((row) => {
      const folds = foldsByInput.get(row.inputFingerprint) ?? new Set<number>()
      folds.add(row.fold)
      foldsByInput.set(row.inputFingerprint, folds)
    })

    expect([...foldsByInput.values()].every((folds) => folds.size === 1)).toBe(true)
    expect([1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1_000, 10_000]).toContain(result.ridgeAlpha)
    expect(result.selectedModel).toBe('ridge')
    expect(result.metrics.ridge.rmse).toBeLessThan(result.metrics.randomForest.rmse)
    expect(result.interval[0]).toBeLessThanOrEqual(result.prediction)
    expect(result.interval[1]).toBeGreaterThanOrEqual(result.prediction)
    expect(result.extrapolatedFeatureKeys).toContain('measurement.vars.width')
  })

  it('비선형 target에서는 Random Forest importance까지 계산한다', () => {
    const dataset = createDataset((width, voltage) => Math.sin(voltage * 2) * 20 + width * 0.1)
    const result = predictDataset(dataset, {
      featureKeys: ['measurement.vars.width', 'measurement.vars.voltage'],
      targetKey: 'target:response',
      whatIf: { 'measurement.vars.width': 3, 'measurement.vars.voltage': 2.5 },
    })

    expect(result.selectedModel).toBe('random-forest')
    expect(result.importanceMethod).toContain('Random Forest')
    expect(result.importances.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(1, 6)
  })

  it('RFC 4180 escaping과 UTF-8 BOM을 적용한 CSV를 만든다', async () => {
    const dataset = createDataset()
    const blob = createCsv(dataset, 'dataset', ['measurement.vars.width', 'target:response'])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const text = await blob.text()

    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(text).toContain('measurement_id,input_fingerprint')
    expect(text.split('\r\n')).toHaveLength(31)
  })
})
