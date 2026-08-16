import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const assets = path.join(dist, 'assets')

async function productionSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name)
      if (entry.isDirectory()) return productionSources(resolved)
      return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [resolved] : []
    }),
  )
  return files.flat()
}

const [indexHtml, packageJson, authoringManifest, runnerHeaders, deploymentConfig] = await Promise.all([
  readFile(path.join(dist, 'index.html'), 'utf8'),
  readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'src/lib/cad/api/authoring-manifest.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'public/_headers'), 'utf8'),
  readFile(path.join(root, '../../deployment/app.conf'), 'utf8'),
])

if (!/^\d+\.\d+\.\d+$/.test(packageJson.dependencies['monaco-editor'])) {
  throw new Error('monaco-editor must be pinned to an exact version.')
}
if (!/^\d+\.\d+\.\d+$/.test(authoringManifest.coreDeclarationVersion)) {
  throw new Error('@caemble/core declaration version must be pinned.')
}
const legacyExecutionSymbols = [
  'ExperimentDefinitionV2',
  'experimentRules',
  'SolverController',
  'solverModules',
  'run-solver',
  'cancel-solver',
  'solver-preflight',
]
const legacySourceMatches = []
for (const file of await productionSources(path.join(root, 'src'))) {
  const source = await readFile(file, 'utf8')
  const symbol = legacyExecutionSymbols.find((candidate) => source.includes(candidate))
  if (symbol) legacySourceMatches.push(`${path.relative(root, file)}: ${symbol}`)
}
if (legacySourceMatches.length > 0) {
  throw new Error(`Legacy CAD execution symbols remain:\n${legacySourceMatches.join('\n')}`)
}

const assetNames = await readdir(assets)
const textFiles = ['index.html', 'runner.html', ...assetNames.filter((name) => /\.(?:css|js)$/.test(name))]
const contents = new Map(
  await Promise.all(
    textFiles.map(async (name) => {
      const filePath = name.endsWith('.html') ? path.join(dist, name) : path.join(assets, name)
      return [name, await readFile(filePath, 'utf8')]
    }),
  ),
)
const runnerHtml = contents.get('runner.html')
const hostCsp =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src https://code-to-cad.caemble.com; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self'"
const runnerCsp =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"
if (!deploymentConfig.includes(`add_header Content-Security-Policy "${hostCsp}" always;`)) {
  throw new Error('The deployment config must allow the regl renderer required by the host UI.')
}
if (!runnerHtml?.includes(runnerCsp) || !runnerHeaders.includes(runnerCsp)) {
  throw new Error('Runner HTML and deployment headers must preserve the isolated runner CSP.')
}
if (runnerHtml.includes('@vite/client') || runnerHtml.includes('react-refresh')) {
  throw new Error('The production runner HTML contains development client code.')
}

for (const [name, source] of contents) {
  if (/cdn\.jsdelivr\.net|esbuild(?:-wasm)?\.wasm|plotly/i.test(source)) {
    throw new Error(`${name} contains a forbidden production dependency.`)
  }
  if (source.includes('new Function') && !name.startsWith('evaluation.worker-')) {
    throw new Error(`${name} contains new Function outside the isolated evaluation Worker.`)
  }
}
const localSimulationMarkers = [
  'Finite-volume matrix contains an isolated cell.',
  'finite-volume matrix is not positive definite.',
  'sim.run() calls must be awaited and executed sequentially.',
]
for (const [name, source] of contents) {
  const marker = localSimulationMarkers.find((candidate) => source.includes(candidate))
  if (marker) throw new Error(`${name} contains browser-local simulation runtime code: ${marker}`)
}
if (assetNames.some((name) => name.endsWith('.wasm'))) {
  throw new Error('The production build contains a WASM asset.')
}

const initialAssetNames = new Set([...indexHtml.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((match) => match[1]))
if ([...initialAssetNames].some((name) => /monaco|editor\.api|tsMode|\.worker/i.test(name))) {
  throw new Error('Monaco must not be referenced by the initial HTML entry.')
}

let initialGzipBytes = 0
for (const name of initialAssetNames) {
  const filePath = path.join(assets, name)
  await stat(filePath)
  initialGzipBytes += gzipSync(await readFile(filePath)).byteLength
}
if (initialGzipBytes > 500 * 1024) {
  throw new Error(`Initial entry is ${(initialGzipBytes / 1024).toFixed(2)} KiB gzip; the limit is 500 KiB.`)
}

console.log(`Production asset checks passed: ${(initialGzipBytes / 1024).toFixed(2)} KiB initial gzip.`)
