import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CliError } from '@/platform/node/environment'
import { exportLocalResult, inspectLocalResult, sliceLocalResult } from '@/platform/node/localResult'
import type { CommandContext } from './types'
import { createDbTables, getListRequest } from '@/api/api'
import { resolveObjects } from '@/api/objectStorage'
import { createDataTensorAccessor } from '@/lib/cad/model/dataTensor'
import type { DataSchema, DataTensor } from '@/lib/cad/model/core'

export async function dataCommand(group: string, command: string, context: CommandContext) {
  const { args, options, signal } = context
  let result: unknown
  if (options.result) {
    if (command === 'export') {
      if (!options.out) throw new CliError('Local data export requires --out <empty-directory>.')
      return exportLocalResult(String(options.result), String(options.out), signal)
    }
    result =
      command === 'slice'
        ? await sliceLocalResult(String(options.result), args[0], {
            offset: Number(options.offset ?? 0),
            limit: Number(options.count ?? 32),
          })
        : await inspectLocalResult(String(options.result))
  } else {
    const resource = group === 'measurement' ? 'measurement' : args[0]
    const id = Number(group === 'measurement' ? args[0] : args[1])
    if (!resource || !Number.isSafeInteger(id) || id < 1) throw new CliError('Specify a resource and positive ID.')
    if (command === 'slice' && resource !== 'recorded_data')
      throw new CliError('slice requires the recorded_data resource.')
    if (command === 'export' && resource === 'recorded_data')
      result = (
        await createDbTables(context.client()).RecordedData.listRows(
          { ...getListRequest(), selected_ids: [id], limit: 1 },
          { signal },
        )
      ).items.find((row) => row.id === id)
    else if (command === 'export' && resource === 'measurement')
      result = await createDbTables(context.client()).Measurement.readResults(id, { signal })
    else
      result = await context
        .client()
        .request(
          'get',
          command === 'slice'
            ? `/data/recorded_data/${id}/slice?offset=${Number(options.offset ?? 0)}&count=${Number(options.count ?? 32)}`
            : `/data/${encodeURIComponent(resource)}/${id}`,
          undefined,
          { signal },
        )
  }
  if (command === 'slice' && result && typeof result === 'object' && 'downloadRequired' in result) {
    const stored = (await resolveObjects(context.client(), result, signal)) as unknown as {
      id: number
      name: string
      schema: DataSchema
      quantityKind: string | null
      data: DataTensor
      offset: number
      count: number
    }
    const accessor = createDataTensorAccessor(stored.schema, stored.data, 'RecordedData')
    const count = Math.min(stored.count, accessor.size - stored.offset)
    const nextOffset = stored.offset + count
    result = {
      id: stored.id,
      name: stored.name,
      quantityKind: stored.quantityKind,
      shape: accessor.shape,
      totalValues: accessor.size,
      offset: stored.offset,
      values: Array.from({ length: count }, (_, index) => accessor.at(stored.offset + index)),
      nextOffset: nextOffset < accessor.size ? nextOffset : null,
    }
  }
  if (command === 'export') {
    if (!options.out) throw new CliError('data export requires --out.')
    await writeFile(String(options.out), JSON.stringify(result, null, 2), 'utf8')
    return { path: path.resolve(String(options.out)) }
  }
  if (command !== 'inspect' && command !== 'slice') throw new CliError('Use inspect, slice, or export.')
  return result
}
