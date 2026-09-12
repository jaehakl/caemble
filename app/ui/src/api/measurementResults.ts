import { z } from 'zod'
import type { MeasurementResults, MeasurementRecordedDataNode } from '@/contracts/api/measurement'
import { measurementRecordedDataSchema } from '@/contracts/api/measurementValidators'
import { measurementVisualizationSchema, recordedResultContractsSchema } from '@/contracts/resultValidators'
import type { MeasurementVisualizations } from '@/contracts/results'
import type { CaembleClient, RequestContext } from './http'
import { resolveObjects } from './objectStorage'

/** A corrupt or unavailable result must not hide its siblings. */
export async function readMeasurementResults(
  client: CaembleClient,
  id: number,
  context?: RequestContext,
): Promise<MeasurementResults> {
  const envelope = await client.request('get', `/measurement/${id}/recorded-data`, undefined, {
    signal: context?.signal,
    validate: (value) =>
      z
        .object({
          recorded_data: z.record(z.string(), z.unknown()),
          result_contracts: recordedResultContractsSchema.nullable(),
        })
        .parse(value),
  })
  const recorded_data: Record<string, MeasurementRecordedDataNode> = {}
  const result_errors: Record<string, string> = {}
  const entries = Object.entries(envelope.recorded_data)
  let completed = 0
  context?.onObjectProgress?.({ completed, total: entries.length })
  for (const [name, value] of entries) {
    context?.signal?.throwIfAborted()
    try {
      const resolved = context?.resolveObjects === false ? value : await resolveObjects(client, value, context?.signal)
      recorded_data[name] = measurementRecordedDataSchema.parse({ [name]: resolved })[name]
    } catch (error) {
      context?.signal?.throwIfAborted()
      result_errors[name] = error instanceof Error ? error.message : String(error)
    }
    context?.onObjectProgress?.({ completed: ++completed, total: entries.length })
  }
  const visualizations: Record<string, Record<string, MeasurementVisualizations[string][string]>> = {}
  try {
    const response = await client.request('get', `/measurement/${id}/visualizations`, undefined, {
      signal: context?.signal,
      validate: (value) =>
        z.object({ visualizations: z.record(z.string(), z.record(z.string(), z.unknown())) }).parse(value),
    })
    for (const [task, values] of Object.entries(response.visualizations ?? {})) {
      visualizations[task] = {}
      for (const [key, value] of Object.entries(values)) {
        try {
          const entry = measurementVisualizationSchema.parse(value)
          if (entry.provenance.task !== task) throw new Error('시각화 결과의 Task 출처가 일치하지 않습니다.')
          const data =
            context?.resolveObjects === false ? entry.data : await resolveObjects(client, entry.data, context?.signal)
          visualizations[task][key] = { ...entry, data }
        } catch (error) {
          context?.signal?.throwIfAborted()
          result_errors[`@visualizations.${task}.${key}`] = error instanceof Error ? error.message : String(error)
        }
      }
    }
  } catch (error) {
    context?.signal?.throwIfAborted()
    result_errors['@visualizations'] = error instanceof Error ? error.message : String(error)
  }
  return { recorded_data, result_contracts: envelope.result_contracts, result_errors, visualizations }
}
