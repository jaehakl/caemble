import { build } from 'esbuild'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const output = path.resolve('dist-cli')
await mkdir(output, { recursive: true })
const fingerprints = {}
for (const [entry, name] of [
  ['src/cli/main.ts', 'caemble'],
  ['src/cli/worker.ts', 'worker'],
]) {
  const result = await build({
    entryPoints: [entry],
    outfile: path.join(output, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    loader: { '.md': 'text' },
    alias: { '@': path.resolve('src') },
    external: ['playwright'],
    define: { 'import.meta.env': '{}' },
    metafile: true,
    logLevel: 'info',
  })
  const forbidden = Object.keys(result.metafile.inputs).filter((file) =>
    /monaco|manifold|regl-renderer|react-dom/u.test(file),
  )
  if (forbidden.length) throw new Error(`CLI imports browser runtime: ${forbidden.join(', ')}`)
  for (const file of Object.keys(result.metafile.inputs).filter(
    (file) => !file.includes('node_modules') && !file.startsWith('<'),
  ))
    fingerprints[file.replace(/\?raw$/, '')] = createHash('sha256')
      .update(await readFile(file.replace(/\?raw$/, '')))
      .digest('hex')
}
const typescriptDirectory = path.dirname(require.resolve('typescript'))
for (const name of (await readdir(typescriptDirectory)).filter((name) => /^lib.*\.d\.ts$/u.test(name)))
  await copyFile(path.join(typescriptDirectory, name), path.join(output, name))
for (const name of ['caemble-core.d.ts', 'cad-jsx.d.ts']) {
  const file = path.join('src/lib/cad/api', name)
  await copyFile(file, path.join(output, name))
  fingerprints[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}
for (const file of ['package.json', 'package-lock.json', 'scripts/build-cli.mjs'])
  fingerprints[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
await writeFile(
  path.join(output, 'build-info.json'),
  JSON.stringify({ version: '1', inputs: fingerprints }, null, 2),
  'utf8',
)
