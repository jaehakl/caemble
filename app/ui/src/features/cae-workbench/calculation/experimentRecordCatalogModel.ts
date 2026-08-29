import type { ExperimentRecordedDataRecord } from '@/api'
import type { RecordedDataRule } from '@/lib/cad'
import type { CalculationRecordedDataSummary } from './calculationRecordedData'

export type ExperimentRecordCatalogStatus = 'unselected' | 'loading' | 'ready' | 'missing' | 'invalid'

export type ExperimentRecordCatalogItem = Readonly<{
  record: ExperimentRecordedDataRecord
  used: boolean | null
  status: ExperimentRecordCatalogStatus
  summary: CalculationRecordedDataSummary | null
}>

export function requiredCalculationRecordedDataRules(
  rules: readonly RecordedDataRule[],
  dependencyNames: readonly string[],
): readonly RecordedDataRule[] {
  return rules.filter((rule) => dependencyNames.includes(rule.label))
}

export function buildExperimentRecordCatalogItems(
  records: readonly ExperimentRecordedDataRecord[],
  dependencyNames: readonly string[] | null,
  measurementSelected: boolean,
  measurementLoading: boolean,
  summaries: readonly CalculationRecordedDataSummary[],
): readonly ExperimentRecordCatalogItem[] {
  const dependencies = dependencyNames === null ? null : new Set(dependencyNames)
  const summariesByPath = new Map(summaries.map((summary) => [summary.path, summary]))
  return Object.freeze(
    records.map((record) => {
      const summary = summariesByPath.get(record.name) ?? null
      return Object.freeze({
        record,
        used: dependencies?.has(record.name) ?? null,
        status: !measurementSelected
          ? 'unselected'
          : measurementLoading
            ? 'loading'
            : summary === null || !summary.present
              ? 'missing'
              : summary.valid
                ? 'ready'
                : 'invalid',
        summary,
      })
    }),
  )
}
