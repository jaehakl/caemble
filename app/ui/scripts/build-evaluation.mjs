import { build } from 'esbuild'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const output = path.resolve('../slaves/evaluation/dist')
await mkdir(output, { recursive: true })
const result = await build({
  entryPoints: ['src/platform/node/evaluationWorker.ts'],
  outfile: path.join(output, 'evaluation.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  loader: { '.md': 'text' },
  alias: { '@': path.resolve('src') },
  define: { 'import.meta.env': '{}' },
  metafile: true,
  logLevel: 'info',
})
if (Object.keys(result.metafile.inputs).some((file) => /monaco|manifold|regl-renderer|react-dom/u.test(file)))
  throw new Error('Evaluation imports a browser runtime.')
const inputs = {}
for (const file of [
  ...Object.keys(result.metafile.inputs).filter((file) => !file.includes('node_modules') && !file.startsWith('<')),
  'package.json',
  'package-lock.json',
  'scripts/build-evaluation.mjs',
  'src/lib/cad/api/caemble-core.d.ts',
  'src/lib/cad/api/cad-jsx.d.ts',
]) {
  const name = file.replace(/\?raw$/, '')
  inputs[name] = createHash('sha256')
    .update(await readFile(name))
    .digest('hex')
}
const typescriptDirectory = path.dirname(require.resolve('typescript'))
const libraries = (await readdir(typescriptDirectory)).filter((name) => /^lib.*\.d\.ts$/u.test(name))
for (const name of libraries) await copyFile(path.join(typescriptDirectory, name), path.join(output, name))
for (const name of ['caemble-core.d.ts', 'cad-jsx.d.ts'])
  await copyFile(path.join('src/lib/cad/api', name), path.join(output, name))
await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ version: '1', inputs }, null, 2), 'utf8')
