import { z } from 'zod'
import type { MeasurementResults, MeasurementRecordedDataNode } from '@/contracts/api/measurement'
import { measurementRecordedDataSchema } from '@/contracts/api/measurementValidators'
import { recordedResultContractsSchema } from '@/contracts/resultValidators'
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
  return { recorded_data, result_contracts: envelope.result_contracts, result_errors }
}
