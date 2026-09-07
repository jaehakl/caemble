import { existsSync } from 'node:fs'
import { Console } from 'node:console'
import path from 'node:path'
import ts from 'typescript'
import { prepareCaeMeasurement } from './caePreparation'

async function main() {
  if (process.argv.includes('--check')) {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 13)) throw new Error('CAE preparation requires Node.js 22.13 or later.')
    const directory = path.dirname(ts.getDefaultLibFilePath({}))
    for (const name of ['lib.es2020.d.ts', 'caemble-core.d.ts', 'cad-jsx.d.ts']) {
      if (!existsSync(path.join(directory, name))) throw new Error(`Missing compiler declaration: ${name}`)
    }
    process.stdout.write(JSON.stringify({ ready: true, node: process.versions.node }))
    return
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 256 * 1024 * 1024) throw new Error('CAE preparation input exceeds 256 MiB.')
    chunks.push(chunk)
  }
  // Authored console messages must not corrupt the stdout JSON response.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
  const result = await prepareCaeMeasurement(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(
    JSON.stringify(result, (_key, value: unknown) =>
      ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value,
    ),
  )
}

main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({
      error: {
        code:
          error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
            ? 'evaluation_timeout'
            : 'preparation_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  )
  process.exitCode = 1
})
