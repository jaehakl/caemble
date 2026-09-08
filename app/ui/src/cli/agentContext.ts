import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAuthoringGuide, getAuthoringReference, type AuthoringScenario } from '@/authoring'
import { createDbTables, getListRequest } from '@/api/api'
import type { ExperimentSourceBundle } from '@/contracts/cad-persistence'
import { cadSourceHash } from '@/lib/cad/source/document'
import { extractCatalogSourceReferences, type CatalogSourceReferences } from '@/lib/catalog/references'
import { analyzeCalculationDependencies } from '@/lib/calculation/dependencies'
import { containedPath, openArtifact, readSourceBundle } from '@/platform/node/artifact'
import { catalogCommand, CliError } from '@/platform/node/environment'
import { inspectLocalResult } from '@/platform/node/localResult'
import type { CommandContext } from './types'

const SOURCE_BUDGET = 64 * 1024
const CHECKOUT_BUDGET = 64 * 1024
const METADATA_BUDGET = 32 * 1024

function captureSource(file: string, source: string, budget: { bytes: number }) {
  const bytes = Buffer.byteLength(source, 'utf8')
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let content = ''
  let includedLines = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8')
    if (size > budget.bytes) break
    content += line
    budget.bytes -= size
    includedLines++
  }
  return {
    file,
    sha256: createHash('sha256').update(source).digest('hex'),
    totalBytes: bytes,
    includedBytes: Buffer.byteLength(content, 'utf8'),
    content,
    complete: content === source,
    startLine: 1,
    ...(content === source
      ? {}
      : { nextLine: includedLines + 1, omittedBytes: bytes - Buffer.byteLength(content, 'utf8') }),
  }
}

function boundedMetadata(value: unknown, next: string, budget: { bytes: number }) {
  const serialized = JSON.stringify(value)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= budget.bytes) {
    budget.bytes -= bytes
    return value
  }
  return {
    omitted: true,
    totalBytes: bytes,
    sha256: createHash('sha256').update(serialized).digest('hex'),
    reason: 'Context metadata byte budget reached.',
    next,
  }
}

/** A read-only, bounded context packet. Source and reference content always identify their exact origin. */
export async function buildAgentContext(context: CommandContext, scenario: AuthoringScenario) {
  const { environment, options, signal } = context
  const guide = getAuthoringGuide(scenario)
  const sourceBudget = { bytes: SOURCE_BUDGET }
  const checkoutBudget = { bytes: CHECKOUT_BUDGET }
  const metadataBudget = { bytes: METADATA_BUDGET }
  const warnings: string[] = []
  let bundle: ExperimentSourceBundle | undefined
  let calculationSource: string | undefined
  let metadata: Record<string, unknown> = {}
  let localArtifact: unknown
  const sources: ReturnType<typeof captureSource>[] = []
  let sourceHash: string | undefined
  let sourceKind: 'experiment-bundle' | 'calculation-source' | 'solver-source-files' | undefined
  let omittedSourceFiles = 0
  let sourceOrigin: string | undefined
  if (options.source) {
    const location = path.resolve(String(options.source))
    const directory = (await stat(location)).isDirectory() ? location : path.dirname(location)
    sourceOrigin = location
    const metadataPath = path.join(directory, 'caemble.json')
    if (existsSync(metadataPath)) {
      const raw = JSON.parse(await readFile(await containedPath(directory, 'caemble.json'), 'utf8')) as Record<
        string,
        unknown
      >
      metadata = Object.fromEntries(
        [
          'kind',
          'id',
          'experiment_id',
          'name',
          'description',
          'revision',
          'base_revision',
          'baseBundleHash',
          'source_hash',
          'namespace',
          'repository_slug',
          'repository',
          'experiment_key',
          'key',
          'version_major',
          'version_minor',
          'version_patch',
        ]
          .filter((key) => key in raw)
          .map((key) => [key, raw[key]]),
      )
    }
    if (existsSync(path.join(directory, 'manifest.json'))) {
      const raw = JSON.parse(await readFile(await containedPath(directory, 'manifest.json'), 'utf8')) as {
        kind?: string
      }
      if (raw.kind === 'caemble.build') {
        const opened = await openArtifact(directory)
        bundle = opened.artifact.source_bundle
        localArtifact = boundedMetadata(
          {
            directory,
            sourceHash: opened.artifact.source_hash,
            catalogRevision: opened.artifact.catalog_revision,
            builderVersion: opened.artifact.builder_version,
            mode: opened.artifact.mode,
            itemCount: opened.artifact.items.length,
            items: opened.artifact.items.slice(0, 20),
            omittedItems: Math.max(0, opened.artifact.items.length - 20),
            inputPayloads: 'not-read',
          },
          'Read the selected artifact manifest or inspect its specific input item.',
          metadataBudget,
        )
      }
    }
    if (!bundle && (location.endsWith('.js') || existsSync(path.join(directory, 'calculation.js')))) {
      calculationSource = await readFile(
        await containedPath(directory, location.endsWith('.js') ? path.basename(location) : 'calculation.js'),
        'utf8',
      )
      sourceHash = createHash('sha256').update(calculationSource).digest('hex')
      sourceKind = 'calculation-source'
      sources.push(captureSource('calculation.js', calculationSource, sourceBudget))
    } else if (!bundle && scenario === 'solver' && !existsSync(path.join(directory, 'experiment.tsx'))) {
      const entries = location.endsWith('.py')
        ? [path.basename(location)]
        : (await readdir(directory, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
            .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
            .filter((file) => !/(^|\/)(\.venv|__pycache__|node_modules|\.git)\//.test(file))
            .sort()
      const captured: Record<string, string> = {}
      for (const file of entries) captured[file] = await readFile(await containedPath(directory, file), 'utf8')
      sourceHash = createHash('sha256').update(JSON.stringify(captured)).digest('hex')
      sourceKind = 'solver-source-files'
      for (const file of entries.slice(0, 128)) sources.push(captureSource(file, captured[file], sourceBudget))
      omittedSourceFiles += Math.max(0, entries.length - 128)
    } else {
      bundle ??= await readSourceBundle(directory)
    }
  }
  const measurementId = options.measurement === undefined ? undefined : Number(options.measurement)
  if (measurementId !== undefined && (!Number.isSafeInteger(measurementId) || measurementId < 1))
    throw new CliError('--measurement must be a positive ID.')
  let measurement: Record<string, unknown> | undefined
  if (measurementId !== undefined) {
    measurement = await context
      .client()
      .request<Record<string, unknown>>('get', `/data/measurement/${measurementId}`, undefined, { signal })
  }
  const selectedExperiment =
    options.experiment ??
    metadata.experiment_id ??
    measurement?.experiment_id ??
    (metadata.kind === 'experiment' ? metadata.id : undefined)
  const experimentId = selectedExperiment === undefined ? undefined : Number(selectedExperiment)
  if (experimentId !== undefined && (!Number.isSafeInteger(experimentId) || experimentId < 1))
    throw new CliError('Context Experiment ID must be positive.')
  if (experimentId !== undefined && measurement && measurement.experiment_id !== experimentId)
    throw new CliError('The selected Measurement belongs to another Experiment.', 4)
  let experiment: unknown
  let recordContracts: unknown
  let dependencies: unknown = {
    status: 'not-analyzed',
    reason: 'Select a Calculation source and an Experiment or local result.',
  }
  if (experimentId !== undefined) {
    const tables = createDbTables(context.client())
    const [rows, records] = await Promise.all([
      tables.Experiment.listRows({ ...getListRequest(), selected_ids: [experimentId], limit: 1 }, { signal }),
      tables.ExperimentRecord.listRows(
        { ...getListRequest(), experiment_id: experimentId, limit: 100, offset: 0 },
        { signal },
      ),
    ])
    const row = rows.items.find((item) => item.id === experimentId)
    if (!row) throw new CliError('The selected Experiment was not found.', 1)
    experiment = boundedMetadata(
      {
        id: row.id,
        name: row.name,
        sourceHash: row.source_hash,
        namespace: row.namespace,
        repository: row.repository_slug,
        key: row.experiment_key,
        version: `${row.version_major}.${row.version_minor}.${row.version_patch}`,
      },
      'experiment pull <id>',
      metadataBudget,
    )
    if (!bundle) {
      bundle = row.source_bundle
      if (!sourceOrigin) sourceOrigin = `remote Experiment ${experimentId}`
      if (!sourceHash) sourceHash = row.source_hash
    } else if (row.source_hash !== (await cadSourceHash({ kind: 'experiment', sourceBundle: bundle }))) {
      warnings.push(
        'Local Experiment source differs from the selected remote revision. Remote record contracts describe the saved revision.',
      )
    }
    if (calculationSource) {
      if (records.items.length < records.total) {
        dependencies = {
          status: 'not-analyzed',
          reason: 'The available ExperimentRecord list is truncated; fetch remaining contracts first.',
        }
      } else {
        try {
          const names = analyzeCalculationDependencies(
            calculationSource,
            records.items.map((record) => record.name),
          )
          dependencies = {
            status: 'analyzed',
            sourceHash,
            names,
            experimentRecordIds: records.items
              .filter((record) => names.includes(record.name))
              .map((record) => record.id),
            execution: 'not-run',
          }
          records.items.sort((left, right) => Number(names.includes(right.name)) - Number(names.includes(left.name)))
        } catch (cause) {
          const problem = cause as Error & { code?: string; diagnostic?: unknown }
          dependencies = {
            status: 'error',
            message: problem.message,
            code: problem.code,
            diagnostic: problem.diagnostic,
            referenceId: 'calculation.dependencies',
            execution: 'not-run',
          }
        }
      }
    }
    recordContracts = boundedMetadata(
      { items: records.items, total: records.total, omittedCount: records.total - records.items.length },
      'Use ExperimentRecord list pagination for this Experiment.',
      metadataBudget,
    )
  }
  if (bundle) {
    const hash = await cadSourceHash({ kind: 'experiment', sourceBundle: bundle })
    if (!sourceKind) {
      sourceHash = hash
      sourceKind = 'experiment-bundle'
    }
    const entries = Object.entries(bundle.files).sort(([left], [right]) => left.localeCompare(right))
    const room = Math.max(0, 128 - sources.length)
    for (const [file, source] of entries.slice(0, room)) sources.push(captureSource(file, source, sourceBudget))
    omittedSourceFiles += Math.max(0, entries.length - room)
  }
  let localResult: unknown
  if (options.result) {
    const inspected = await inspectLocalResult(String(options.result))
    localResult = boundedMetadata(
      {
        sourceHash: inspected.manifest.sourceHash,
        inputHash: inspected.manifest.inputHash,
        catalogRevision: inspected.manifest.catalogRevision,
        state: inspected.manifest.state,
        jobId: inspected.manifest.jobId,
        durationMs: inspected.manifest.durationMs,
        records: inspected.records.slice(0, 100).map((record) => ({
          ...record,
          axes: record.axes.map((axis) => ({
            tickCount: axis.ticks?.length ?? null,
            ...(axis.implicitOrdinal ? { implicitOrdinal: true } : {}),
          })),
        })),
        omittedRecords: Math.max(0, inspected.records.length - 100),
        values: 'not-included',
      },
      'data inspect --result <directory> or data slice <record> --result <directory>',
      metadataBudget,
    )
    if (calculationSource && experimentId === undefined) {
      try {
        dependencies = {
          status: 'analyzed',
          sourceHash,
          names: analyzeCalculationDependencies(
            calculationSource,
            inspected.records.map((record) => record.name),
          ),
          execution: 'not-run',
        }
      } catch (cause) {
        const problem = cause as Error & { code?: string; diagnostic?: unknown }
        dependencies = {
          status: 'error',
          message: problem.message,
          code: problem.code,
          diagnostic: problem.diagnostic,
          referenceId: 'calculation.dependencies',
          execution: 'not-run',
        }
      }
    }
  }
  const catalogMeta = await catalogCommand(environment, 'meta', [], options.catalog as string | undefined)
  let names: CatalogSourceReferences | undefined
  if (bundle) {
    try {
      names = extractCatalogSourceReferences(bundle)
    } catch (cause) {
      warnings.push(
        `Catalog reference extraction failed: ${cause instanceof Error ? cause.message : String(cause)}. Source checks still need to run.`,
      )
    }
  }
  const queries = names
    ? [
        ...names.solvers.map((solver) => ({
          kind: 'solver',
          key: solver.name,
          args: ['--key', solver.name, '--version', solver.version],
        })),
        ...names.quantityKinds.map((key) => ({ kind: 'quantity-kind', key, args: ['--key', key] })),
        ...names.materialModels.map((key) => ({ kind: 'material-model', key, args: ['--key', key] })),
      ]
    : []
  if (
    scenario === 'solver' &&
    options.name &&
    queries.every((query) => query.kind !== 'solver' || query.key !== options.name)
  ) {
    queries.unshift({
      kind: 'solver',
      key: String(options.name),
      args: ['--key', String(options.name), ...(options.version ? ['--version', String(options.version)] : [])],
    })
  }
  const relevantCatalog = []
  for (const query of queries.slice(0, 12)) {
    signal.throwIfAborted()
    try {
      const value = await catalogCommand(environment, query.kind, query.args, options.catalog as string | undefined)
      relevantCatalog.push({
        kind: query.kind,
        key: query.key,
        value: boundedMetadata(value, `catalog show ${query.kind} ${query.key}`, metadataBudget),
      })
    } catch (cause) {
      relevantCatalog.push({
        kind: query.kind,
        key: query.key,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  const checkoutPaths =
    scenario === 'solver'
      ? [
          'docs/development/solver-development.md',
          'app/slaves/cae/AGENTS.md',
          'app/slaves/cae/app/kernel/coordinator/program.py',
          'app/slaves/cae/app/kernel/coordinator/simulation.py',
        ]
      : scenario === 'experiment'
        ? ['app/slaves/cae/app/kernel/coordinator/program.py', 'app/slaves/cae/app/kernel/coordinator/simulation.py']
        : ['app/ui/src/lib/calculation/sourcePolicy.ts', 'app/ui/src/lib/calculation/dependencies.ts']
  const checkoutSources = []
  for (const file of checkoutPaths) {
    const source = await readFile(await containedPath(environment.repo, file), 'utf8')
    checkoutSources.push(captureSource(file, source, checkoutBudget))
  }
  return {
    kind: 'caemble.agent-context',
    version: 1,
    scenario,
    guide,
    source: {
      origin: sourceOrigin,
      kind: sourceKind,
      sourceHash,
      metadata: boundedMetadata(metadata, 'Read caemble.json in the selected source directory.', metadataBudget),
      files: sources,
      complete: omittedSourceFiles === 0 && sources.every((source) => source.complete),
      omittedFiles: omittedSourceFiles,
      ...(sources.length === 0 ? { note: 'No source selected. Use --source <directory> or --experiment <id>.' } : {}),
    },
    experiment,
    measurement: measurement
      ? boundedMetadata(measurement, `data inspect measurement ${measurementId}`, metadataBudget)
      : undefined,
    recordContracts,
    dependencies,
    localArtifact,
    localResult,
    catalog: {
      meta: catalogMeta,
      sourceReferences: names,
      relevantContracts: relevantCatalog,
      omittedContracts: Math.max(0, queries.length - 12),
    },
    references: guide.referenceIds.map((id) => getAuthoringReference(id)),
    checkoutSources,
    validation: 'Context capture only; this command does not compile, validate Python or run code.',
    limits: {
      sourceBytes: SOURCE_BUDGET,
      checkoutBytes: CHECKOUT_BUDGET,
      metadataBytes: METADATA_BUDGET,
      sourceFiles: 128,
      recordContracts: 100,
      catalogContracts: 12,
    },
    excluded: ['credentials and .env', 'full recorded tensor values', 'unrelated Catalog records', 'solver execution'],
    warnings,
    next: [
      'reference show <id>',
      'experiment check <source-directory>',
      'calculation check <source-directory>',
      'calculation run <source-directory>/calculation.js --fixture <complete-input.json>',
      'data slice recorded_data <id> --count 32',
    ],
  }
}
