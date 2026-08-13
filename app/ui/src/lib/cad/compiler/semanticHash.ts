import { parse } from '@babel/parser'
import { EXPERIMENT_SIMULATION_PATH, type CadSourceDocument } from '../source/document'
import { compileCadDocument } from './monacoCompiler'
import type { CompiledCadDocument, CompiledCadSource } from './types'

const ignoredAstFields = new Set([
  'comments',
  'end',
  'errors',
  'extra',
  'innerComments',
  'leadingComments',
  'loc',
  'start',
  'tokens',
  'trailingComments',
])

function canonicalAstValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAstValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignoredAstFields.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalAstValue(item)]),
  )
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function rawCodeHash(code: string) {
  return sha256(code)
}

export async function compiledCadSemanticHash(compiled: CompiledCadSource) {
  const code = compiled.code.replace(/\r?\n\/\/# sourceURL=caemble:\/\/[^\r\n]+\/?$/, '')
  const ast = parse(code, { attachComment: false, sourceType: 'script' })
  return sha256(JSON.stringify(canonicalAstValue(ast.program)))
}

export async function compiledCadDocumentSemanticHash(
  compiled: CompiledCadDocument,
  pythonSource: string | null = null,
) {
  const sourceHashes = await Promise.all(
    Object.entries(compiled.sources)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(async ([path, source]) => [path, await compiledCadSemanticHash(source)] as const),
  )
  if (!compiled.geometryGraph) return sha256(JSON.stringify({ sources: sourceHashes, pythonSource }))
  const geometryModules = await Promise.all(
    Object.entries(compiled.geometryGraph.modules)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(async ([coordinate, source]) => [coordinate, await compiledCadSemanticHash(source)] as const),
  )
  return sha256(
    JSON.stringify({
      sources: sourceHashes,
      pythonSource,
      geometryGraph: {
        roots: compiled.geometryGraph.roots,
        modules: geometryModules,
      },
    }),
  )
}

export async function cadSemanticHash(document: CadSourceDocument) {
  const compiled = await compileCadDocument(document)
  const pythonSource = document.kind === 'experiment' ? document.sourceBundle.files[EXPERIMENT_SIMULATION_PATH] : null
  return compiledCadDocumentSemanticHash(compiled, pythonSource)
}
