import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createDbTables, getListRequest } from '@/api/api'
import { fetchCalculationInput } from '@/api/calculationInput'
import type { CalculationInput, NormalizedCalculationOutput } from '@/lib/calculation/types'
import { assertCalculationInput } from '@/lib/calculation/validation'
import { analyzeCalculationDependencies } from '@/lib/calculation/dependencies'
import { commandJson, CliError } from '@/platform/node/environment'
import { createLocalCalculationInput, inspectLocalResult } from '@/platform/node/localResult'
import type { CommandContext } from './types'

async function execute(context: CommandContext, source: string, input: CalculationInput) {
  assertCalculationInput(input)
  analyzeCalculationDependencies(source, Object.keys(input))
  const result = (await commandJson(process.execPath, [context.environment.worker], {
    cwd: context.environment.cae,
    signal: context.signal,
    timeoutMs: Number(context.options.timeout ?? 30) * 1000,
    input: { operation: 'calculation-run', source, input },
  })) as { sourceHash: string; output: NormalizedCalculationOutput; logs: string[] }
  for (const log of result.logs) process.stderr.write(`${log}\n`)
  return result
}

export async function calculationCommand(group: string, command: string, context: CommandContext): Promise<unknown> {
  const { args, options, environment, signal } = context
  if (group === 'calculation-data') {
    if (!options.experiment) throw new CliError('calculation-data requires --experiment.')
    const tables = createDbTables(context.client())
    const experimentId = Number(options.experiment)
    if (command === 'export') {
      if (!options.out) throw new CliError('export requires --out.')
      const limit = Number(options.limit ?? options.count ?? 100)
      const offset = Number(options.offset ?? 0)
      if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0)
        throw new CliError('Export limit/count and offset must be nonnegative integers.')
      const analysis = await tables.CalculationData.analysis(experimentId, { signal })
      const selected = analysis.items.filter(
        (item) =>
          (!options.calculation || item.calculation_id === Number(options.calculation)) &&
          (!options.measurement || item.measurement_id === Number(options.measurement)),
      )
      const ids = selected.slice(offset, offset + limit).map((item) => item.calculation_data_id)
      const items = [] as import('@/contracts/api/calculation').CalculationDataRecord[]
      for (let index = 0; index < ids.length; index += 50) {
        const page = await tables.CalculationData.listRows(
          {
            ...getListRequest(),
            experiment_id: experimentId,
            selected_ids: ids.slice(index, index + 50),
            limit: 50,
            offset: 0,
          },
          { signal },
        )
        items.push(...page.items)
      }
      const byId = new Map(items.map((item) => [item.id, item]))
      const rows = { total: selected.length, items: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) }
      await writeFile(String(options.out), JSON.stringify(rows), 'utf8')
      return { path: path.resolve(String(options.out)), count: rows.items.length, total: rows.total }
    }
    const response = await tables.CalculationData.missing(
      {
        experiment_id: experimentId,
        ...(options.calculation && !options.measurement ? { calculation_id: Number(options.calculation) } : {}),
        ...(options.measurement ? { measurement_id: Number(options.measurement) } : {}),
      },
      { signal },
    )
    const requestedItems = options.calculation
      ? response.items.filter((item) => item.calculation_id === Number(options.calculation))
      : response.items
    const missing = { total: requestedItems.length, items: requestedItems }
    if (command === 'missing') return missing
    if (command !== 'run') throw new CliError('Unknown calculation-data command.')
    const completed: unknown[] = []
    for (const item of missing.items) {
      signal.throwIfAborted()
      const calculation = (
        await tables.Calculation.listRows(
          { ...getListRequest(), experiment_id: experimentId, selected_ids: [item.calculation_id], limit: 1 },
          { signal },
        )
      ).items.find((row) => row.id === item.calculation_id)
      if (!calculation) throw new CliError(`Calculation ${item.calculation_id} was not found.`, 1)
      const prepared = await fetchCalculationInput(
        context.client(),
        item.measurement_id,
        calculation.source_code,
        signal,
      )
      const result = await execute(context, calculation.source_code, prepared.input)
      completed.push(
        await tables.CalculationData.save({ ...item, source_hash: result.sourceHash, data: result.output }),
      )
      process.stderr.write(`CalculationData ${completed.length}/${missing.total}\n`)
    }
    return { completed: completed.length, total: missing.total }
  }
  if (command === 'init') {
    const directory = path.resolve(String(options.out ?? args[0] ?? 'calculation'))
    await mkdir(directory, { recursive: true })
    if ((await readdir(directory)).length) throw new CliError('Calculation destination must be empty.')
    const source =
      '/** Draft: replace the constant with statically named Record input access. */\nexport default function calculation(input) {\n  return { dtype: "float64", data: 0 };\n}\n'
    await writeFile(path.join(directory, 'calculation.js'), source, 'utf8')
    await writeFile(
      path.join(directory, 'caemble.json'),
      JSON.stringify({ kind: 'calculation', draft: true, name: options.name ?? path.basename(directory) }, null, 2),
      'utf8',
    )
    return { directory, draft: true, next: 'agent guide calculation' }
  }
  if (command === 'list') {
    if (!options.experiment) throw new CliError('calculation list requires --experiment.')
    return createDbTables(context.client()).Calculation.listRows(
      {
        ...getListRequest(),
        experiment_id: Number(options.experiment),
        limit: Number(options.limit ?? 24),
        offset: Number(options.offset ?? 0),
      },
      { signal },
    )
  }
  if (command === 'pull') {
    const id = Number(args[0])
    const row = (
      await createDbTables(context.client()).Calculation.listRows({ ...getListRequest(), selected_ids: [id], limit: 1 })
    ).items.find((item) => item.id === id)
    if (!row) throw new CliError('Calculation was not found.', 1)
    const directory = path.resolve(String(options.out ?? `calculation-${id}`))
    await mkdir(directory, { recursive: true })
    if ((await readdir(directory)).length) throw new CliError('Calculation destination must be empty.')
    const { source_code, ...metadata } = row
    await writeFile(path.join(directory, 'calculation.js'), source_code, 'utf8')
    await writeFile(
      path.join(directory, 'caemble.json'),
      JSON.stringify({ kind: 'calculation', ...metadata }, null, 2),
      'utf8',
    )
    return { directory, id }
  }
  const location = path.resolve(args[0] ?? '.')
  const sourcePath = location.endsWith('.js') ? location : path.join(location, 'calculation.js')
  const source = await readFile(sourcePath, 'utf8')
  if (command === 'check') {
    const compiled = (await commandJson(process.execPath, [environment.worker], {
      cwd: environment.cae,
      signal,
      input: { operation: 'calculation-check', source },
    })) as { sourceHash: string }
    return {
      syntax: 'passed',
      source_hash: compiled.sourceHash,
      execution: 'not-run',
      reference_id: 'calculation.contract',
    }
  }
  if (command === 'run') {
    const selected = [options.fixture, options.result, options.measurement].filter(Boolean)
    if (selected.length !== 1) throw new CliError('Select exactly one input: --fixture, --result, or --measurement.')
    const prepared = options.measurement
      ? await fetchCalculationInput(context.client(), Number(options.measurement), source, signal)
      : null
    const local = options.result ? await inspectLocalResult(String(options.result)) : null
    const localNames = local
      ? analyzeCalculationDependencies(
          source,
          local.records.map((record) => record.name),
        )
      : []
    const input = options.fixture
      ? JSON.parse(await readFile(String(options.fixture), 'utf8'))
      : options.result
        ? await createLocalCalculationInput(String(options.result), localNames)
        : prepared!.input
    const result = await execute(context, source, input)
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const output = {
      kind: 'caemble.calculation-result',
      source_hash: result.sourceHash,
      input_hash: inputHash,
      output: result.output,
      provenance: options.measurement
        ? {
            kind: 'remote-measurement',
            measurement_id: Number(options.measurement),
            record_contracts: prepared!.recordContracts,
            catalog: await context.client().request('get', '/client/capabilities'),
          }
        : options.result
          ? { kind: 'local-cae-result', path: path.resolve(String(options.result)) }
          : { kind: 'fixture', path: path.resolve(String(options.fixture)) },
      ...(options.out
        ? {
            input_file: `${path.basename(String(options.out))}.input.json`,
            source_file: `${path.basename(String(options.out))}.source.js`,
          }
        : {}),
    }
    if (options.out) {
      await writeFile(`${String(options.out)}.input.json`, JSON.stringify(input), 'utf8')
      await writeFile(`${String(options.out)}.source.js`, source, 'utf8')
      await writeFile(String(options.out), JSON.stringify(output, null, 2), 'utf8')
    }
    return output
  }
  if (command !== 'push') throw new CliError(`Unknown calculation command: ${command}`)
  if (!options.measurement)
    throw new CliError(
      'Calculation push requires --measurement for a fresh server Measurement preflight. Local fixtures cannot replace it.',
      6,
    )
  const metadataPath = path.join(path.dirname(sourcePath), 'caemble.json')
  const metadata = existsSync(metadataPath) ? JSON.parse(await readFile(metadataPath, 'utf8')) : {}
  const experimentId = Number(options.experiment ?? metadata.experiment_id)
  if (!Number.isSafeInteger(experimentId) || experimentId < 1)
    throw new CliError('Calculation push requires --experiment.')
  const measurementId = Number(options.measurement)
  const tables = createDbTables(context.client())
  const measurement = (
    await tables.Measurement.listRows({ ...getListRequest(), selected_ids: [measurementId], limit: 1 })
  ).items.find((item) => item.id === measurementId)
  if (!measurement || measurement.experiment_id !== experimentId || !measurement.recorded_at)
    throw new CliError('Preflight requires a completed Measurement of the target Experiment.', 6)
  const prepared = await fetchCalculationInput(context.client(), measurementId, source, signal)
  const result = await execute(context, source, prepared.input)
  const { data: _data, ...output_layout } = result.output
  void _data
  const saved = await tables.Calculation.upsertRow([
    {
      ...(metadata.id ? { id: metadata.id, base_revision: metadata.revision } : {}),
      experiment_id: experimentId,
      name: String(options.name ?? metadata.name ?? path.basename(path.dirname(sourcePath))),
      description: metadata.description ?? null,
      source_code: source,
      source_hash: result.sourceHash,
      output_layout,
      preflight_measurement_id: measurementId,
      contract_status: 'ready',
      experiment_record_ids: prepared.experimentRecordIds,
    },
  ])
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata, ...saved[0], experiment_id: experimentId, source_hash: result.sourceHash }, null, 2),
    'utf8',
  )
  return { ...saved[0], preflight_measurement_id: measurementId, source_hash: result.sourceHash }
}
