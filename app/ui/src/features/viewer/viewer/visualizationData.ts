import type { MeasurementVisualizations, RecordedResultContracts, ResultProvenance } from '@/contracts/results'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { flattenRecordedData, recordedDataRules } from '@/lib/cad/simulation/recordedData'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'

/** Adapt the isolated visualization channel at the Viewer boundary only. */
export function visualizationData(visualizations: MeasurementVisualizations) {
  const contracts: Record<string, RecordedResultContracts[string]> = {}
  const rules: RecordedDataRule[] = []
  const data: Record<string, RecordedData[string]> = {}
  const errors: Record<string, string> = {}
  const provenance: Record<string, ResultProvenance> = {}
  for (const [task, entries] of Object.entries(visualizations)) {
    for (const [key, entry] of Object.entries(entries)) {
      const name = `@visualizations.${task}.${key}`
      try {
        provenance[name] = entry.provenance
        const schema = { [name]: entry.schema } as RecordedDataSchemaTree
        contracts[name] = {
          task,
          output: key,
          solver: entry.provenance.solver,
          catalogRevision: entry.provenance.catalogRevision,
          artifactType: entry.contract.artifactType,
          visualization: entry.contract.visualization,
          schema: entry.schema,
        }
        rules.push(...recordedDataRules(schema, 'visualization'))
        Object.assign(data, flattenRecordedData(schema, { [name]: entry.data } as RecordedData))
      } catch (error) {
        errors[name] = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return { contracts, rules, data, errors, provenance }
}
