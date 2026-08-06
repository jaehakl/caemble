import { describe, expect, it } from 'vitest'
import type { MeasurementRecord, RecordedDataRecord, SampleRecord, SetupRecord } from '@/api'
import {
  buildAnalysisDataset,
  createCsv,
  createMeasurementRanges,
  getTablePage,
  mineDataset,
  predictDataset,
} from './analysis-engine'

function createDataset(targetValue = (width: number, voltage: number) => width * 3 + voltage * 2) {
  const samples: SampleRecord[] = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    structure_id: 11,
    vars: {
      width: index + 1,
      sampleId: index + 100,
      metadata: { revision: index },
      nested: { offset: index * 0.25 },
    },
    material_parameters: { schemaVersion: 1, materials: {} },
  }))
  const setups: SetupRecord[] = Array.from({ length: 6 }, (_, index) => ({
    id: index + 101,
    experiment_id: 22,
    vars: { voltage: index + 0.5, steps: index + 2 },
    material_parameters: { schemaVersion: 1, materials: {} },
  }))
  const measurements: MeasurementRecord[] = []
  const recordedData: RecordedDataRecord[] = []
  samples.forEach((sample) => {
    setups.forEach((setup) => {
      const id = measurements.length + 1_000
      measurements.push({ id, sample_id: sample.id!, setup_id: setup.id! })
      const width = sample.vars.width as number
      const voltage = setup.vars.voltage as number
      recordedData.push({
        id: id + 10_000,
        measurement_id: id,
        name: 'response',
        dtype: 'float64',
        quantity_kind: 'Dimensionless',
        tensor_order: 0,
        data: { value: targetValue(width, voltage) },
      })
      recordedData.push({
        id: id + 20_000,
        measurement_id: id,
        name: 'state',
        dtype: 'string',
        quantity_kind: 'Dimensionless',
        tensor_order: 0,
        data: { value: width > 2 ? 'wide' : 'narrow' },
      })
    })
  })
  return buildAnalysisDataset({
    experimentId: 22,
    fingerprint: 'fixture',
    measurements,
    recordedData,
    samples,
    setups,
    structureId: 11,
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

  it('scalar profile과 categorical 빈도, 100행 이하 table page를 만든다', () => {
    const dataset = createDataset()
    const response = dataset.profile.columns.find((column) => column.key === 'target:response')

    expect(dataset.profile).toMatchObject({
      rowCount: 30,
      sampleCount: 5,
      setupCount: 6,
      recordedDataCount: 60,
    })
    expect(response?.eligible).toBe(true)
    expect(response?.histogram?.length).toBeGreaterThan(1)
    expect(dataset.profile.columns.some((column) => column.key.includes('sampleId'))).toBe(false)
    expect(dataset.profile.columns.some((column) => column.key.includes('metadata'))).toBe(false)
    expect(dataset.profile.categoricalSummaries[0]).toMatchObject({
      name: 'state',
      counts: expect.arrayContaining([
        { value: 'wide', count: 18 },
        { value: 'narrow', count: 12 },
      ]),
    })
    expect(getTablePage(dataset, ['sample.vars.width', 'target:response'], 0, 1).rows).toHaveLength(1)
    expect(getTablePage(dataset, ['sample.vars.width'], 0, 1_000).rows).toHaveLength(30)
  })

  it('seed 42로 PCA·K-Means·reconstruction anomaly를 재현한다', () => {
    const firstDataset = createDataset()
    const secondDataset = createDataset()
    const options = {
      featureKeys: ['sample.vars.width', 'sample.vars.nested.offset', 'setup.vars.voltage'],
      outlierFraction: 0.05,
      targetKey: 'target:response',
      xKey: 'sample.vars.width',
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

  it('Sample group을 fold 사이에 섞지 않고 Ridge·Random Forest를 비교한다', () => {
    const dataset = createDataset()
    const result = predictDataset(dataset, {
      featureKeys: ['sample.vars.width', 'setup.vars.voltage'],
      targetKey: 'target:response',
      whatIf: { 'sample.vars.width': 20, 'setup.vars.voltage': 2 },
    })
    const foldsBySample = new Map<number, Set<number>>()
    result.rows.forEach((row) => {
      const folds = foldsBySample.get(row.sampleId) ?? new Set<number>()
      folds.add(row.fold)
      foldsBySample.set(row.sampleId, folds)
    })

    expect([...foldsBySample.values()].every((folds) => folds.size === 1)).toBe(true)
    expect([1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1_000, 10_000]).toContain(result.ridgeAlpha)
    expect(result.selectedModel).toBe('ridge')
    expect(result.metrics.ridge.rmse).toBeLessThan(result.metrics.randomForest.rmse)
    expect(result.interval[0]).toBeLessThanOrEqual(result.prediction)
    expect(result.interval[1]).toBeGreaterThanOrEqual(result.prediction)
    expect(result.extrapolatedFeatureKeys).toContain('sample.vars.width')
  })

  it('비선형 target에서는 Random Forest importance까지 계산한다', () => {
    const dataset = createDataset((width, voltage) => Math.sin(voltage * 2) * 20 + width * 0.1)
    const result = predictDataset(dataset, {
      featureKeys: ['sample.vars.width', 'setup.vars.voltage'],
      targetKey: 'target:response',
      whatIf: { 'sample.vars.width': 3, 'setup.vars.voltage': 2.5 },
    })

    expect(result.selectedModel).toBe('random-forest')
    expect(result.importanceMethod).toContain('Random Forest')
    expect(result.importances.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(1, 6)
  })

  it('RFC 4180 escaping과 UTF-8 BOM을 적용한 CSV를 만든다', async () => {
    const dataset = createDataset()
    const blob = createCsv(dataset, 'dataset', ['sample.vars.width', 'target:response'])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const text = await blob.text()

    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(text).toContain('measurement_id,sample_id,setup_id')
    expect(text.split('\r\n')).toHaveLength(31)
  })
})
