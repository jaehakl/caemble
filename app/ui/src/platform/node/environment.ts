import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export function executionEnvironment() {
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'temp',
    'tmp',
    'home',
    'userprofile',
    'localappdata',
    'appdata',
    'comspec',
    'pathext',
    'lang',
    'lc_all',
    'cuda_path',
    'cuda_home',
    'ld_library_path',
    'dyld_library_path',
    'omp_num_threads',
  ])
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toLowerCase())),
  )
}

export async function commandJson(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string
    input?: unknown
    timeoutMs?: number
    signal?: AbortSignal
    cooperativeCancel?: boolean
  }>,
) {
  options.signal?.throwIfAborted()
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: executionEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let length = 0
    let expired = false
    let force: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      if (options.cooperativeCancel) {
        child.stdin.write('{"type":"cancel"}\n')
        force = setTimeout(() => child.kill(), 10_000)
      } else child.kill()
    }
    const timer = setTimeout(() => {
      expired = true
      cancel()
    }, options.timeoutMs ?? 120_000)
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 256 * 1024 * 1024) {
        child.kill()
        reject(new CliError('Child output exceeded 256 MiB.', 1))
        return
      }
      chunks.push(chunk)
    })
    child.stdin.on('error', () => undefined)
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      options.signal?.removeEventListener('abort', cancel)
      if (options.signal?.aborted) {
        reject(new CliError('Interrupted.', 130))
        return
      }
      if (expired) {
        reject(new CliError('Execution timed out.', 5))
        return
      }
      try {
        const output = Buffer.concat(chunks).toString('utf8').trim()
        const result = output ? JSON.parse(output) : undefined
        if (code !== 0)
          reject(
            new CliError(
              result?.error?.message ?? `Process exited with status ${code}.`,
              result?.error?.exitCode ?? (code !== null && [2, 3, 4, 5, 6, 130].includes(code) ? code : 1),
              result?.error,
            ),
          )
        else resolve(result)
      } catch (error) {
        reject(error)
      }
    })
    if (options.input !== undefined) child.stdin.end(JSON.stringify(options.input))
    else if (!options.cooperativeCancel) child.stdin.end()
  })
}

export async function resolveEnvironment(
  options: Readonly<{ repo?: string; env?: string; python?: string; requirePython?: boolean }>,
) {
  let repo = path.resolve(options.repo ?? __dirname)
  if (!options.repo) {
    while (!existsSync(path.join(repo, 'app/slaves/cae/pyproject.toml'))) {
      const parent = path.dirname(repo)
      if (parent === repo) throw new CliError('Cannot locate the Caemble checkout. Use --repo.')
      repo = parent
    }
  }
  repo = await realpath(repo)
  const cae = path.join(repo, 'app/slaves/cae')
  if (!existsSync(path.join(cae, 'pyproject.toml'))) throw new CliError('The selected repo is not a Caemble checkout.')
  const envPath = path.resolve(options.env ?? '.env')
  const fileEnv = existsSync(envPath) ? parseEnv(await readFile(envPath, 'utf8')) : {}
  const env = { ...fileEnv, ...process.env }
  let python = options.python ?? env.CAEMBLE_PYTHON
  if (!python && options.requirePython !== false) {
    python = await new Promise<string>((resolve, reject) => {
      const child = spawn('poetry', ['env', 'info', '--executable'], {
        cwd: cae,
        env: executionEnvironment(),
        windowsHide: true,
      })
      let output = ''
      child.stdout.on('data', (value) => {
        output += String(value)
      })
      child.stderr.on('data', (value) => process.stderr.write(value))
      child.on('error', () =>
        reject(new CliError('Poetry could not locate CAE Python. Use --python with the CAE interpreter.')),
      )
      child.on('close', (code) =>
        code === 0 && output.trim()
          ? resolve(output.trim())
          : reject(new CliError('Run poetry install in the selected CAE checkout, or supply --python.')),
      )
    })
  }
  python = python ? await realpath(path.resolve(python)) : ''
  return {
    repo,
    cae,
    python,
    envPath,
    apiUrl: env.CAEMBLE_API_URL,
    token: env.CAEMBLE_API_TOKEN,
    cli: path.join(repo, 'app/ui/dist-cli/caemble.cjs'),
    worker: path.join(repo, 'app/ui/dist-cli/worker.cjs'),
  }
}
export type CliEnvironment = Awaited<ReturnType<typeof resolveEnvironment>>

export async function verifyPython(environment: CliEnvironment) {
  const info = (await commandJson(environment.python, ['-X', 'utf8', '-m', 'app.kernel.transport.local', 'doctor'], {
    cwd: environment.cae,
  })) as { ready: boolean; modules: Record<string, string>; python: string; [key: string]: unknown }
  if (!info.ready)
    throw new CliError(
      'CAE Python is missing required modules. Run poetry install --with dev in the selected CAE checkout.',
      2,
      info,
    )
  for (const [name, location] of Object.entries(info.modules)) {
    const resolved = path.resolve(location)
    const root = name === 'cae' || name === 'program' || name === 'runtime' ? environment.cae : environment.repo
    const relative = path.relative(root, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new CliError(`${name} resolves outside the selected checkout: ${location}`, 4)
  }
  return info
}

export async function catalogCommand(
  environment: CliEnvironment,
  command: string,
  args: readonly string[] = [],
  database?: string,
) {
  return commandJson(
    environment.python,
    [
      '-X',
      'utf8',
      '-m',
      'app.kernel.transport.local',
      'catalog',
      command,
      ...args,
      ...(database ? ['--database', path.resolve(database)] : []),
    ],
    { cwd: environment.cae },
  )
}
