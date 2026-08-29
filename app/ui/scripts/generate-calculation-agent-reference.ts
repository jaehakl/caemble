import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CALCULATION_MONACO_DECLARATION, CALCULATION_SOURCE_SKELETON } from '../src/lib/calculation/declarations'
import { CALCULATION_MATHJS_REFERENCE } from '../src/lib/calculation/mathjsManifest'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CALCULATION_TIMEOUT_MS,
} from '../src/lib/calculation/types'

const root = process.cwd()
const outputPath = path.resolve(root, '../api/app/ai/calculation_authoring_reference.json')
const reference = {
  language: 'javascript',
  contract: {
    export: 'One synchronous default-export function with one identifier parameter.',
    import: "Only named imports from 'mathjs' are allowed.",
    input: 'A read-only dotted-path map of ExperimentRecord-backed RecordedData tensor leaves.',
    dependencies:
      'Use only fixed record.member, record[\'dotted.path\'], static object destructuring, or traceable const aliases. Dynamic keys, enumeration, spread, reassignment, and passing or returning the whole record are rejected when saving.',
    output: 'Return { dtype, data, axes? }; shape is inferred from rank-0/1/2 finite real data.',
    axes: 'Axes are optional. When supplied, every axis and tick must match the inferred shape and units use UCUM.',
    validation: 'Complex final values, NaN, Infinity, ragged arrays, rank above 2, and explicit shape are rejected.',
    persistence:
      'Saving a new or source-changed Calculation requires a successful preflight; its source hash, ExperimentRecord dependencies, and exact dtype/shape/axes output layout become the stored contract.',
    indexing:
      'Dynamic bracket indexes are allowed only when they resolve to non-negative safe integers. Dynamic string properties are rejected.',
    console:
      'The frozen console exposes only log; direct, fixed-string bracket, and aliased console.log calls are allowed.',
    security:
      'Prototype and constructor access, dynamic Math members, random functions, native Object/Array aliases, globals, and dynamic imports remain blocked.',
  },
  limits: {
    inputBytes: CALCULATION_INPUT_MAX_BYTES,
    outputElements: CALCULATION_OUTPUT_MAX_ELEMENTS,
    executionMilliseconds: CALCULATION_TIMEOUT_MS,
    automaticSourceContextBytes: 64 * 1024,
    relatedContextBytes: 32 * 1024,
  },
  mathjs: CALCULATION_MATHJS_REFERENCE,
  declaration: CALCULATION_MONACO_DECLARATION,
  skeleton: CALCULATION_SOURCE_SKELETON,
}
const serialized = `${JSON.stringify(reference, null, 2)}\n`

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8')
  assert.equal(current, serialized, 'Calculation Agent reference is stale. Run npm run generate:calculation-agent.')
} else {
  await writeFile(outputPath, serialized, 'utf8')
}
