import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const assetsDirectory = fileURLToPath(new URL('../dist/assets/', import.meta.url))
const assetNames = await readdir(assetsDirectory)
const calculationWorkers = assetNames.filter((name) => /^runner\.worker-[A-Za-z0-9_-]+\.js$/u.test(name))
const cadWorkers = assetNames.filter((name) => /^evaluation\.worker-[A-Za-z0-9_-]+\.js$/u.test(name))
assert.equal(calculationWorkers.length, 1, 'The build must contain exactly one hashed Calculation Worker.')
assert.equal(cadWorkers.length, 1, 'The build must retain exactly one separate CAD evaluation Worker.')

const javascriptNames = assetNames.filter((name) => name.endsWith('.js'))
const contents = new Map(
  await Promise.all(
    javascriptNames.map(async (name) => [
      name,
      await readFile(new URL(`../dist/assets/${name}`, import.meta.url), 'utf8'),
    ]),
  ),
)
const calculationCode = contents.get(calculationWorkers[0])
assert.ok(
  calculationCode?.includes('calculation-success'),
  'The Calculation protocol marker is missing from its Worker.',
)
assert.ok(calculationCode?.includes('RK45'), 'The curated Math.js numeric ODE runtime is missing from its Worker.')
assert.deepEqual(
  [...contents].filter(([, code]) => code.includes('RK45')).map(([name]) => name),
  calculationWorkers,
  'Math.js runtime code must be isolated to the Calculation Worker.',
)
assert.equal(
  contents.get(cadWorkers[0])?.includes('calculation-success'),
  false,
  'CAD Worker must not contain Calculation runtime code.',
)

const runnerHtml = await readFile(new URL('../dist/runner.html', import.meta.url), 'utf8')
assert.match(runnerHtml, /connect-src 'none'/u, 'Runner document CSP must block connections.')
const nginxConfig = await readFile(new URL('../../../deployment/app.conf', import.meta.url), 'utf8')
assert.match(
  nginxConfig,
  /location ~ \^\/assets\/runner\\\.worker-\[A-Za-z0-9_-\]\+\\\.js\$[\s\S]*?connect-src 'none'/u,
  'Production must serve the hashed Calculation Worker with connect-src none.',
)
