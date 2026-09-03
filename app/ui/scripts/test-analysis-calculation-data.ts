import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CalculationDataAnalysisItem, MeasurementRecord } from '../src/api'
import {
  analyzeRelationships,
  buildAnalysisDataset,
  createCsv,
  getRelationshipPlot,
  getTablePage,
  mineDataset,
} from '../src/features/analysis/analysis-engine'

const measurements = [
  ...Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    experiment_id: 7,
    vars: { x: index + 1, z: (index + 1) ** 2 },
    material_parameters: {
      experiment: {
        materials: {
          Alloy: {
            density: { value: { kind: 'constant', unit: 'kg/m3', value: 7_000 + index * 10 } },
          },
        },
      },
      tasks: {},
    },
    recorded_at: '2026-01-01T00:00:00Z',
    calculation_data_count: 0,
    updated_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
  })),
  {
    id: 999,
    experiment_id: 7,
    vars: { x: 999, z: 999 },
    material_parameters: { experiment: { materials: {} }, tasks: {} },
    recorded_at: null,
    calculation_data_count: 0,
    updated_at: '2026-02-01T00:00:00Z',
  },
] satisfies MeasurementRecord[]

const calculationData = Array.from({ length: 24 }, (_, index) => {
  const measurementId = index + 1
  return [
    {
      calculation_id: 10,
      calculation_name: 'Scalar result',
      measurement_id: measurementId,
      dtype: 'float64',
      summary: { kind: 'scalar', value: measurementId * 2 + 3 },
    },
    {
      calculation_id: 20,
      calculation_name: 'Tensor result',
      measurement_id: measurementId,
      dtype: 'float64',
      summary: {
        kind: 'tensor',
        rank: 1,
        count: index % 2 === 0 ? 2 : 5,
        mean: measurementId + 10,
        std: measurementId / 10 + 1,
      },
    },
    {
      calculation_id: 30,
      calculation_name: 'Mixed rank',
      measurement_id: measurementId,
      dtype: 'float64',
      summary:
        index < 12
          ? { kind: 'scalar', value: measurementId }
          : { kind: 'tensor', rank: 1, count: 2, mean: measurementId, std: measurementId / 2 },
    },
    {
      calculation_id: 40,
      calculation_name: 'Mixed dtype',
      measurement_id: measurementId,
      dtype: index < 12 ? 'float64' : 'int32',
      summary: { kind: 'scalar', value: measurementId + 100 },
    },
  ] satisfies CalculationDataAnalysisItem[]
}).flat()

const dataset = buildAnalysisDataset({
  calculationData,
  experimentId: 7,
  fingerprint: 'fixture',
  measurements,
})

assert.equal(dataset.profile.rowCount, 24)
assert.equal(dataset.profile.measurementCount, 24)
assert.equal(dataset.profile.calculationDataCount, 96)
assert.equal(dataset.profile.calculationCount, 4)
assert.equal(
  dataset.rows.some((row) => row.measurementId === 999),
  false,
)
assert.equal(dataset.columns.get('measurement.vars.x')?.descriptor.source, 'measurement-vars')
assert.equal(
  dataset.columns.get('measurement.material.experiment.Alloy.density')?.descriptor.source,
  'measurement-material',
)

const scalarKey = 'target:calculation:10'
const tensorMeanKey = 'target:calculation:20:mean'
const tensorStdKey = 'target:calculation:20:std'
assert.deepEqual(
  Array.from(dataset.columns.get(scalarKey)?.values ?? []),
  calculationData
    .slice(0, 96)
    .filter((_, index) => index % 4 === 0)
    .map((row) => (row.summary.kind === 'scalar' ? row.summary.value : Number.NaN)),
)
assert.equal(dataset.columns.get(tensorMeanKey)?.descriptor.statistic, 'mean')
assert.equal(dataset.columns.get(tensorStdKey)?.descriptor.statistic, 'std')
assert.equal(
  [...dataset.columns.keys()].some((key) => /:(min|max|p05|p50|p95)$/u.test(key)),
  false,
)
assert.equal(dataset.columns.get('target:calculation:30')?.descriptor.eligible, false)
assert.match(dataset.columns.get('target:calculation:30')?.descriptor.exclusionReason ?? '', /dtype 또는 rank/u)
assert.equal(dataset.columns.get('target:calculation:40')?.descriptor.eligible, false)
assert.equal(dataset.columns.get(tensorMeanKey)?.descriptor.eligible, true)

const relationships = analyzeRelationships(dataset)
assert.ok(relationships.pairs.some((pair) => pair.inputKey === 'measurement.vars.x' && pair.targetKey === scalarKey))
const plot = getRelationshipPlot(dataset, 'measurement.vars.x', scalarKey)
assert.equal(plot.points.length, 24)
assert.equal(plot.points[0].measurementId, 1)

const mining = mineDataset(dataset, {
  featureKeys: ['measurement.vars.x', 'measurement.vars.z'],
  outlierFraction: 0.05,
})
assert.equal(mining.points.length, 24)

const table = getTablePage(dataset, ['measurement.vars.x', scalarKey, tensorMeanKey], 0, 100)
assert.equal(table.rows.length, 24)
assert.deepEqual(table.rows[0].values, [1, 5, 11])
const csv = await createCsv(dataset, ['measurement.vars.x', scalarKey]).text()
assert.match(csv, /measurement_id,input_fingerprint,measurement\.vars\.x,target:calculation:10/u)
assert.doesNotMatch(csv, /\[object Object\]/u)

const workerSource = readFileSync('src/features/analysis/analysis.worker.ts', 'utf8')
assert.doesNotMatch(workerSource, /RecordedData|Recorded Data|dbTables\.RecordedData/u)
assert.doesNotMatch(workerSource, /predict(?:-what-if)?|analysis-prediction\.csv/iu)

const pageSource = readFileSync('src/features/analysis/AnalysisPage.tsx', 'utf8')
assert.doesNotMatch(pageSource, /value="prediction"|Prediction CSV|export-prediction/u)

const engineSource = readFileSync('src/features/analysis/analysis-engine.ts', 'utf8')
assert.doesNotMatch(engineSource, /ml-random-forest|predictDataset|fitRidge|RandomForestRegression/u)

const typesSource = readFileSync('src/features/analysis/analysis-types.ts', 'utf8')
assert.doesNotMatch(typesSource, /AnalysisPredictionResult|AnalysisWhatIfResult|type: 'predict/u)

const docsSource = readFileSync('src/features/docs/docsKnowledge.ts', 'utf8')
assert.doesNotMatch(docsSource, /Analysis: Explore, Mining, Prediction|Prediction CSV|OOF 검증으로 Ridge/u)

console.info('CalculationData Analysis tests passed.')
