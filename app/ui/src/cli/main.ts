import { buildAgentContext } from './agentContext'
import { documents, searchDocuments } from '@/documentation'
import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { ApiError, createCaembleClient } from '@/api/http'
import {
  catalogCommand,
  CliError,
  executionEnvironment,
  resolveEnvironment,
  verifyPython,
} from '@/platform/node/environment'
import { experimentCommand } from './experiment'
import { batchCommand } from './batch'
import { calculationCommand } from './calculation'
import { dataCommand } from './data'
import {
  getAuthoringGuide,
  listAuthoringGuides,
  listAuthoringReferences,
  searchAuthoringReference,
  getAuthoringReference,
} from '@/authoring'
import type { CommandContext } from './types'

const help = `Caemble CLI — run from the Caemble checkout (Node >=24.14)
  doctor [--api] [--chromium]
  experiment init <dir> --example <catalog-key>
  experiment list | pull <id> --out <dir> | push <dir> --artifact <artifact> [--new-version patch|minor|major]
  experiment check [source] | build [source] --out <artifact> [--example <key>] [--count N] [--vars-mode nominal|random]
  experiment test <artifact> --out <results> [--timeout seconds]
  batch submit <artifact> --experiment <id> | list | show <id> | watch <id> | cancel <id> | retry <id>
  calculation init <dir> | list --experiment <id> | pull <id> --out <dir> | check <source.js>
  calculation run <source.js> --fixture <input.json> | --result <local-run> | --measurement <id>
  calculation push <dir> --experiment <id> --measurement <id>
  calculation-data missing|run|export --experiment <id> [--calculation <id>] [--measurement <id>]
  measurement inspect <id> | data inspect|slice|export <resource> <id> [--offset N --count N]
  data export --result <local-result> --out <empty-directory>
  agent guide|context solver|experiment|calculation [--source <dir> --measurement <id>]
  reference search <query> | show <id> | export --out <dir>
  docs search <query> | show <document-id|scenario>
  catalog search <query> | show <resource> [key] [--catalog <draft.sqlite3>]
  png geometry <artifact> --out <image.png> | png calculation <result.json> --out <image.png>
Global: --repo <checkout> --python <CAE-python> --env <file> --json
.env: CAEMBLE_API_URL, CAEMBLE_API_TOKEN; process environment takes precedence.
check/build never runs a Solver; test is local; submit is remote. Ctrl+C watch only stops observation.
`

async function main() {
  const stringOptions = [
    'repo',
    'python',
    'env',
    'out',
    'example',
    'catalog',
    'vars',
    'vars-mode',
    'material-parameters',
    'materials',
    'mode',
    'count',
    'evaluation-timeout',
    'measurement',
    'experiment',
    'calculation',
    'fixture',
    'result',
    'artifact',
    'source',
    'name',
    'namespace',
    'repository',
    'key',
    'new-version',
    'limit',
    'offset',
    'query',
    'timeout',
    'jobs',
    'request-id',
    'version',
    'item',
    'task',
    'width',
    'height',
    'camera',
    'chromium-path',
  ]
  const { values: parsedValues, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      ...stringOptions.map((name) => [name, { type: 'string' as const }]),
      ...['json', 'help', 'api', 'chromium'].map((name) => [name, { type: 'boolean' as const }]),
    ]),
  })
  const values = parsedValues as import('./types').CliOptions
  if (values.help || !positionals.length) {
    process.stdout.write(help)
    return
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 14)) throw new CliError('Node 24.14 or newer is required.')
  const [group, command = '', ...args] = positionals
  const requirePython =
    group === 'doctor' ||
    group === 'catalog' ||
    (group === 'agent' && command === 'context') ||
    (group === 'experiment' && !['list', 'pull', 'push'].includes(command))
  const environment = await resolveEnvironment({
    ...(values as { repo?: string; env?: string; python?: string }),
    requirePython,
  })
  const controller = new AbortController()
  const interrupt = () => controller.abort(new CliError('Interrupted.', 130))
  process.once('SIGINT', interrupt)
  const context: CommandContext = {
    environment,
    options: values,
    args,
    signal: controller.signal,
    client: () => {
      if (!environment.apiUrl || !environment.token)
        throw new CliError('Configure CAEMBLE_API_URL and CAEMBLE_API_TOKEN (caemble scope).')
      const url = new URL(environment.apiUrl)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new CliError('CAEMBLE_API_URL must be an HTTP(S) API base URL without credentials, query, or fragment.')
      return createCaembleClient({ baseUrl: environment.apiUrl, auth: { kind: 'bearer', token: environment.token } })
    },
  }
  let result: unknown
  try {
    if (group === 'doctor') {
      const cli = await realpath(process.argv[1])
      const metadata = JSON.parse(await readFile(path.join(path.dirname(cli), 'build-info.json'), 'utf8'))
      const stale: string[] = []
      for (const [file, hash] of Object.entries(metadata.inputs)) {
        try {
          if (
            createHash('sha256')
              .update(await readFile(path.join(environment.repo, 'app/ui', file)))
              .digest('hex') !== hash
          )
            stale.push(file)
        } catch {
          stale.push(file)
        }
      }
      result = {
        node: process.versions.node,
        executable: process.execPath,
        repo: environment.repo,
        cli,
        worker: environment.worker,
        cliCurrent: stale.length === 0,
        stale,
        python: await verifyPython(environment),
        references: listAuthoringGuides().map((guide) => guide.id),
        ...(values.api ? { api: await context.client().request('get', '/client/capabilities') } : {}),
      }
      if (values.chromium) {
        const { chromium } = await import('playwright')
        const browser = await chromium.launch({
          headless: true,
          env: executionEnvironment(),
          executablePath: values['chromium-path'] as string | undefined,
        })
        result = { ...(result as object), chromium: browser.version() }
        await browser.close()
      }
      if (stale.length) throw new CliError('CLI sources changed. Run npm run build:cli in app/ui.', 4, result)
    } else if (group === 'experiment') result = await experimentCommand(command, context)
    else if (group === 'batch') result = await batchCommand(command, context)
    else if (group === 'calculation' || group === 'calculation-data')
      result = await calculationCommand(group, command, context)
    else if (group === 'measurement' || group === 'data') result = await dataCommand(group, command, context)
    else if (group === 'catalog') {
      await verifyPython(environment)
      result =
        command === 'search'
          ? await catalogCommand(
              environment,
              'search',
              ['--query', args.join(' '), ...(values.limit ? ['--limit', String(values.limit)] : [])],
              values.catalog as string,
            )
          : command === 'show'
            ? await catalogCommand(
                environment,
                args[0] ?? 'meta',
                [
                  ...(args[1] ? ['--key', args[1]] : []),
                  ...(values.version ? ['--version', String(values.version)] : []),
                  ...(values.query ? ['--query', String(values.query)] : []),
                  ...(values.limit ? ['--limit', String(values.limit)] : []),
                  ...(values.offset ? ['--offset', String(values.offset)] : []),
                ],
                values.catalog as string,
              )
            : (() => {
                throw new CliError('Use catalog search or catalog show.')
              })()
    } else if (group === 'docs') {
      if (command === 'search') result = searchDocuments(args.join(' '))
      else if (command === 'show') {
        result = ['experiment', 'calculation', 'solver'].includes(args[0])
          ? getAuthoringGuide(args[0] as 'experiment' | 'calculation' | 'solver')
          : documents.find((document) => document.id === args[0])
        if (!result) throw new CliError(`Unknown document: ${args[0]}. Use docs search to find its ID.`)
      } else throw new CliError('Use docs search or docs show.')
    } else if (group === 'agent' || group === 'reference') {
      if (group === 'reference') {
        if (command === 'search') result = searchAuthoringReference(args.join(' '))
        else if (command === 'show') result = getAuthoringReference(args[0])
        else if (command === 'export') {
          if (!values.out) throw new CliError('reference export requires --out.')
          await mkdir(String(values.out), { recursive: true })
          await writeFile(
            path.join(String(values.out), 'reference.json'),
            JSON.stringify(listAuthoringReferences(), null, 2),
            'utf8',
          )
          for (const file of ['caemble-core.d.ts', 'cad-jsx.d.ts'])
            await writeFile(
              path.join(String(values.out), file),
              await readFile(path.join(environment.repo, 'app/ui/src/lib/cad/api', file), 'utf8'),
              'utf8',
            )
          result = { directory: path.resolve(String(values.out)) }
        } else throw new CliError('Unknown reference command.')
      } else if (command === 'search')
        result = listAuthoringGuides().filter((guide) =>
          JSON.stringify(guide).toLowerCase().includes(args.join(' ').toLowerCase()),
        )
      else {
        const scenario = args[0] as 'experiment' | 'calculation' | 'solver'
        const guide = getAuthoringGuide(scenario)
        if (command === 'context') {
          result = await buildAgentContext(context, scenario)
        } else if (command === 'guide' || command === 'show') result = guide
        else throw new CliError('Unknown documentation command.')
      }
    } else if (group === 'png') {
      const { pngCommand } = await import('./png')
      result = await pngCommand(command, context)
    } else throw new CliError(`Unknown command group: ${group}`)
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, values.json ? undefined : 2)}\n`)
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}
void main().catch((error: unknown) => {
  const issue = error as Error & { code?: string; details?: unknown }
  const exitCode =
    error instanceof CliError
      ? error.exitCode
      : error instanceof ApiError
        ? [401, 403].includes(error.status)
          ? 3
          : [409, 422, 426].includes(error.status)
            ? 4
            : 1
        : issue.name === 'AbortError'
          ? 130
          : issue.code?.startsWith('ERR_PARSE_ARGS')
            ? 2
            : 1
  const destination = process.argv.includes('--json') ? process.stdout : process.stderr
  destination.write(`${JSON.stringify({ error: { message: issue.message, exitCode, details: issue.details } })}\n`)
  process.exitCode = exitCode
})
