import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { commandJson } from './environment'

/** File transport keeps large Build and RecordedData payloads out of stdout. */
export async function workerRequest(
  worker: string,
  options: Readonly<{ input: unknown; cwd: string; signal?: AbortSignal; timeoutMs?: number }>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'caemble-node-'))
  try {
    const input_file = path.join(directory, 'input.json')
    const output_file = path.join(directory, 'output.json')
    await writeFile(input_file, JSON.stringify(options.input), 'utf8')
    await commandJson(process.execPath, [worker], { ...options, input: { input_file, output_file } })
    return JSON.parse(await readFile(output_file, 'utf8')) as unknown
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
