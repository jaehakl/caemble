import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cacheDirectory = path.resolve('node_modules/.cache')
await mkdir(cacheDirectory, { recursive: true })
const temporaryDirectory = await mkdtemp(path.join(cacheDirectory, 'caemble-cae-fixture-'))
const bundledEntry = path.join(temporaryDirectory, 'export-cae-fixture.mjs')

try {
  await build({
    entryPoints: [path.resolve('scripts/export-cae-fixture-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['esbuild'],
    define: {
      'import.meta.env.MODE': '"test"',
    },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    outfile: bundledEntry,
    logLevel: 'silent',
  })
  const moduleUrl = pathToFileURL(bundledEntry)
  moduleUrl.searchParams.set('run', Date.now().toString())
  await import(moduleUrl.href)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
