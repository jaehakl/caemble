import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cacheDirectory = path.resolve('node_modules/.cache')
await mkdir(cacheDirectory, { recursive: true })
const temporaryDirectory = await mkdtemp(path.join(cacheDirectory, 'caemble-cae-fixture-'))
const bundledEntry = path.join(temporaryDirectory, 'export-cae-fixture.mjs')
const manifoldWasmPath = path.resolve('node_modules/manifold-3d/manifold.wasm')

try {
  await build({
    entryPoints: [path.resolve('scripts/export-cae-fixture-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['esbuild'],
    plugins: [
      {
        name: 'manifold-wasm-path',
        setup(buildContext) {
          buildContext.onResolve({ filter: /^manifold-3d\/manifold\.wasm\?url$/u }, () => ({
            path: 'manifold-wasm-path',
            namespace: 'caemble',
          }))
          buildContext.onLoad({ filter: /.*/u, namespace: 'caemble' }, () => ({
            contents: `export default ${JSON.stringify(manifoldWasmPath)}`,
            loader: 'js',
          }))
        },
      },
    ],
    define: {
      'import.meta.env.MODE': '"export"',
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
