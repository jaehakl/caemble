import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { format } from 'prettier'
import { calculationAuthoringReference } from '../src/authoring/calculationReference'

const root = process.cwd()
const outputPath = path.resolve(root, 'src/authoring/generated/calculation-reference.json')

const serialized = await format(JSON.stringify(calculationAuthoringReference), { parser: 'json', printWidth: 120 })

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8')
  assert.equal(
    current.replace(/\r\n/g, '\n'),
    serialized,
    'Calculation authoring reference is stale. Run npm run generate:authoring.',
  )
} else {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, 'utf8')
}
