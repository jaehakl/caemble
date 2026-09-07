import { build } from 'esbuild'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const output = path.resolve('dist-cae')
await mkdir(output, { recursive: true })
const result = await build({
  entryPoints: ['src/server/prepare.ts'],
  outfile: path.join(output, 'prepare.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  alias: { '@': path.resolve('src') },
  metafile: true,
  logLevel: 'info',
})
const forbidden = Object.keys(result.metafile.inputs).filter((name) =>
  /monaco|manifold|regl-renderer|react-dom/u.test(name),
)
if (forbidden.length) throw new Error(`Server preparation imported browser rendering code: ${forbidden.join(', ')}`)
const typescriptDirectory = path.dirname(require.resolve('typescript'))
for (const name of (await readdir(typescriptDirectory)).filter((name) => /^lib.*\.d\.ts$/u.test(name))) {
  await copyFile(path.join(typescriptDirectory, name), path.join(output, name))
}
for (const name of ['caemble-core.d.ts', 'cad-jsx.d.ts']) {
  await copyFile(path.join('src/lib/cad/api', name), path.join(output, name))
}
