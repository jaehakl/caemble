import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { cadSourceHash, type CadSourceDocument } from '../source/document'
import { experimentTypeScriptPaths } from '../source/moduleResolution'
import { catalogRuntimeTypes } from './catalogTypeEnvironment'
import { compileInWorker } from './compilerClient'
import { cadCompilerEnvironment } from './compilerDeclarations'

export { CadCompilationError } from './compilationError'

export type CompileCadDocumentOptions = Readonly<{
  catalogRevision?: string
  catalog?: CatalogRuntimeSlice
  signal?: AbortSignal
}>

export async function compileCadDocument(document: CadSourceDocument, options: CompileCadDocumentOptions = {}) {
  options.signal?.throwIfAborted()
  // Hashing and compilation must use the same input even if the caller replaces its files.
  const snapshot: CadSourceDocument = { ...document, sourceBundle: { files: { ...document.sourceBundle.files } } }
  const catalogTypes = options.catalog ? catalogRuntimeTypes(options.catalog) : 'export {}'
  const revision = options.catalogRevision ?? options.catalog?.catalogRevision ?? 'catalog-independent'
  const environment = new TextEncoder().encode(JSON.stringify([cadCompilerEnvironment, revision, catalogTypes]))
  const [sourceHash, environmentDigest] = await Promise.all([
    cadSourceHash(snapshot),
    crypto.subtle.digest('SHA-256', environment),
  ])
  options.signal?.throwIfAborted()
  const environmentHash = [...new Uint8Array(environmentDigest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  const sources = Object.fromEntries(
    experimentTypeScriptPaths(snapshot.sourceBundle.files).map((path) => [path, snapshot.sourceBundle.files[path]]),
  )
  const compiled = await compileInWorker(
    `${environmentHash}:${sourceHash}`,
    { sourceHash, sources, catalogTypes },
    options.signal,
  )
  options.signal?.throwIfAborted()
  return compiled
}
