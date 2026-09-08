import { testLocalArtifact } from '@/platform/node/localExecution'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDbTables, getListRequest } from '@/api/api'
import { BUILD_VERSION, type BuildArtifact } from '@/contracts/build'
import type { CatalogRuntimeSlice, CatalogExperimentDetail } from '@/contracts/catalog'
import type { ExperimentSourceBundle } from '@/contracts/cad-persistence'
import { cadSourceHash } from '@/lib/cad/source/document'
import { experimentRecordContracts } from '@/lib/cad/simulation/recordedData'
import { parseArtifactInput } from '@/lib/cae/artifact'
import { catalogCommand, commandJson, CliError, verifyPython } from '@/platform/node/environment'
import { readSourceBundle, openArtifact, writeSourceBundle } from '@/platform/node/artifact'
import type { CommandContext } from './types'

export async function buildExperiment(context: CommandContext, output: string) {
  const { environment, options, signal } = context
  await verifyPython(environment)
  const source = path.resolve(context.args[0] ?? '.')
  const example = options.example
    ? ((await catalogCommand(
        environment,
        'example',
        ['--key', String(options.example)],
        options.catalog as string,
      )) as CatalogExperimentDetail)
    : null
  const source_bundle: ExperimentSourceBundle = example?.sourceBundle ?? (await readSourceBundle(source))
  const source_hash = await cadSourceHash({ kind: 'experiment', sourceBundle: source_bundle })
  const catalog = (await catalogCommand(environment, 'runtime', [], options.catalog as string)) as CatalogRuntimeSlice
  const vars = options.vars ? JSON.parse(await readFile(String(options.vars), 'utf8')) : undefined
  const frozen = options['material-snapshot']
    ? JSON.parse(await readFile(String(options['material-snapshot']), 'utf8'))
    : undefined
  const mode = options.mode ?? 'generate'
  if (mode !== 'generate' && mode !== 'candidate' && mode !== 'measurement') throw new CliError('Invalid --mode.')
  const varsMode = options['vars-mode'] ?? 'random'
  if (varsMode !== 'nominal' && varsMode !== 'random') throw new CliError('--vars-mode must be nominal or random.')
  const count = Number(options.count ?? 1)
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000 || (mode !== 'generate' && count !== 1))
    throw new CliError('Invalid build count (1–100000, fixed mode requires 1).')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new CliError('Artifact output directory must be empty.')
  await mkdir(path.join(output, 'items'))
  const artifact: BuildArtifact = {
    kind: 'caemble.build',
    version: 2,
    source_hash,
    catalog_revision: catalog.catalogRevision,
    builder_version: BUILD_VERSION,
    source_bundle,
    mode,
    items: [],
  }
  for (let index = 1; index <= count; index++) {
    signal.throwIfAborted()
    const file = `items/${index}.json`
    const target = path.join(output, file)
    process.stderr.write(`Building ${index}/${count}\n`)
    const built = await commandJson(process.execPath, [environment.worker], {
      cwd: environment.cae,
      signal,
      input: {
        operation: 'build',
        output: target,
        build: {
          source_bundle,
          source_hash,
          catalog,
          mode,
          vars,
          vars_mode: varsMode,
          material_snapshot: frozen,
          evaluation_timeout_ms: Number(options['evaluation-timeout'] ?? 3000),
        },
      },
    })
    const validation = await commandJson(
      environment.python,
      ['-X', 'utf8', '-m', 'app.kernel.transport.local', 'validate', '--input', target],
      { cwd: environment.cae, signal },
    )
    const bytes = await readFile(target)
    parseArtifactInput(JSON.parse(bytes.toString('utf8')), artifact)
    const item = {
      index,
      file,
      input_hash: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.byteLength,
      ...(options.measurement ? { measurement_id: Number(options.measurement) } : {}),
    }
    artifact.items.push(item)
    await writeFile(
      path.join(output, `validation-${index}.json`),
      JSON.stringify(
        {
          source_hash,
          input_hash: item.input_hash,
          types: 'passed',
          build: 'passed',
          python: validation,
          solver: 'not-run',
          numerical: 'not-run',
          details: built,
        },
        null,
        2,
      ),
      'utf8',
    )
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(artifact, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  })
  return {
    artifact: output,
    source_hash,
    catalog_revision: artifact.catalog_revision,
    items: count,
    syntax: 'passed',
    build: 'passed',
    execution: 'not-run',
    numerical: 'not-run',
  }
}

export async function experimentCommand(command: string, context: CommandContext): Promise<unknown> {
  const { environment, options, args, signal } = context
  if (command === 'build' || command === 'check') {
    const output = options.out
      ? path.resolve(String(options.out))
      : command === 'check'
        ? await mkdtemp(path.join(tmpdir(), 'caemble-check-'))
        : null
    if (!output) throw new CliError('experiment build requires --out <artifact-directory>.')
    return buildExperiment(context, output)
  }
  if (command === 'test') {
    if (!args[0] || !options.out) throw new CliError('experiment test <artifact> requires --out <result-directory>.')
    return testLocalArtifact(environment, args[0], path.resolve(String(options.out)), {
      signal,
      timeout: options.timeout ? Number(options.timeout) : undefined,
    })
  }
  if (command === 'init' || command === 'pull') {
    let bundle: ExperimentSourceBundle
    let metadata: Record<string, unknown>
    if (command === 'init') {
      if (!options.example)
        throw new CliError(
          'Select a runnable Catalog example using --example. Find examples with catalog search or catalog show examples.',
        )
      await verifyPython(environment)
      const example = (await catalogCommand(
        environment,
        'example',
        ['--key', String(options.example)],
        options.catalog as string,
      )) as CatalogExperimentDetail
      bundle = example.sourceBundle
      metadata = {
        kind: 'experiment',
        example: options.example,
        namespace: 'local',
        repository: 'experiments',
        key: example.key,
        name: example.key,
      }
    } else {
      const id = Number(args[0])
      const row = (
        await createDbTables(context.client()).Experiment.listRows({
          ...getListRequest(),
          selected_ids: [id],
          limit: 1,
        })
      ).items.find((item) => item.id === id)
      if (!row) throw new CliError('Experiment was not found.', 1)
      bundle = row.source_bundle
      metadata = {
        kind: 'experiment',
        id,
        baseBundleHash: row.source_hash,
        namespace: row.namespace,
        repository: row.repository_slug,
        key: row.experiment_key,
        name: row.name,
        description: row.description,
      }
    }
    const directory = path.resolve(String(options.out ?? (command === 'init' ? args[0] : undefined) ?? 'experiment'))
    await writeSourceBundle(directory, bundle)
    await writeFile(path.join(directory, 'caemble.json'), JSON.stringify(metadata, null, 2), 'utf8')
    return { directory, ...metadata }
  }
  if (command === 'list')
    return createDbTables(context.client()).Experiment.listRows({
      ...getListRequest(),
      search_text: String(options.query ?? ''),
      limit: Number(options.limit ?? 24),
    })
  if (command === 'push') {
    const directory = path.resolve(args[0] ?? '.')
    const metadataPath = path.join(directory, 'caemble.json')
    const metadata = existsSync(metadataPath) ? JSON.parse(await readFile(metadataPath, 'utf8')) : {}
    if (!options.artifact)
      throw new CliError('experiment push requires a checked --artifact matching the current source.')
    const stored = await openArtifact(String(options.artifact))
    const sourceBundle = await readSourceBundle(directory)
    const bundleHash = await cadSourceHash({ kind: 'experiment', sourceBundle })
    if (bundleHash !== stored.artifact.source_hash)
      throw new CliError('Build artifact does not match the working source. Run experiment build.', 4)
    const first = parseArtifactInput(
      JSON.parse((await stored.readItem(stored.artifact.items[0])).toString()),
      stored.artifact,
    )
    const records = experimentRecordContracts(first.measurement.experiment.simulationProgram.recordedData)
    const mode = options['new-version'] ? 'new_version' : metadata.id ? 'overwrite' : 'create'
    const result = await createDbTables(context.client()).Experiment.save({
      namespace: String(options.namespace ?? metadata.namespace ?? 'local'),
      repository: String(options.repository ?? metadata.repository ?? 'experiments'),
      key: String(options.key ?? metadata.key ?? path.basename(directory)),
      name: String(options.name ?? metadata.name ?? path.basename(directory)),
      description: metadata.description ?? null,
      sourceBundle,
      bundleHash,
      records,
      ...(mode === 'create'
        ? { mode, initialVersion: '0.1.0' }
        : mode === 'overwrite'
          ? { mode, experimentId: metadata.id, baseBundleHash: metadata.baseBundleHash }
          : {
              mode,
              experimentId: metadata.id,
              baseBundleHash: metadata.baseBundleHash,
              bump: String(options['new-version']) as 'patch' | 'minor' | 'major',
            }),
    })
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, ...result, id: result.id, baseBundleHash: result.bundleHash }, null, 2),
      'utf8',
    )
    return result
  }
  throw new CliError(`Unknown experiment command: ${command}`)
}
