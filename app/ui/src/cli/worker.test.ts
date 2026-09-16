// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'

let directory: string
let worker: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'caemble-cli-worker-'))
  worker = path.join(directory, 'worker.cjs')
  await build({
    entryPoints: [path.resolve('src/cli/worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    loader: { '.md': 'text' },
    alias: { '@': path.resolve('src') },
    external: ['playwright'],
    define: { 'import.meta.env': '{}' },
  })
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it.each([
  ['일', 1],
  ['일', 2],
  ['😀', 1],
  ['😀', 2],
  ['😀', 3],
] as const)('preserves UTF-8 when worker stdin splits %s after byte %i', async (character, offset) => {
  const source = '// 균일 질량 밀도 😀\ninvalid syntax for a diagnostic'
  const request = Buffer.from(JSON.stringify({ operation: 'calculation-check', source }), 'utf8')
  const split = request.indexOf(Buffer.from(character, 'utf8')) + offset
  // Acknowledge consumption of the first chunk before sending the rest. This
  // forces a real pipe boundary without depending on timers or OS buffer sizes.
  const bootstrap = `
    const iterator = process.stdin[Symbol.asyncIterator].bind(process.stdin)
    process.stdin[Symbol.asyncIterator] = async function* () {
      for await (const chunk of iterator()) {
        yield chunk
        process.send('consumed')
      }
    }
    require(process.argv[1])
  `
  const child = spawn(process.execPath, ['--eval', bootstrap, worker], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  const output: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk))
  child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk))
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  child.once('message', () => child.stdin!.end(request.subarray(split)))
  child.stdin!.write(request.subarray(0, split))
  try {
    expect(await closed, Buffer.concat(errors).toString('utf8')).toBe(1)
    const result = JSON.parse(Buffer.concat(output).toString('utf8'))
    expect(result.error.sourceHash).toBe(createHash('sha256').update(source, 'utf8').digest('hex'))
    expect(result.error.stage).toBe('compile')
  } finally {
    if (child.exitCode === null) child.kill()
  }
})
