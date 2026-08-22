import { CadModelError } from '../model/core'
import type { Tensor } from '../model/types'
import { assertExperimentSourcePath, assertExperimentSourcePaths } from './moduleResolution'

export const CAD_SOURCE_FORMAT_VERSION = 2 as const
export const CAD_SOURCE_API_VERSION = 8 as const
export const EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION = 6 as const
export const MAX_CAD_SOURCE_BYTES = 1024 * 1024

export const EXPERIMENT_ENTRY_PATH = 'experiment.tsx' as const
export const EXPERIMENT_GEOMETRY_PATH = 'geometry.tsx' as const
export const EXPERIMENT_MATERIAL_PATH = 'material.tsx' as const
export const EXPERIMENT_SIMULATION_PATH = 'simulate.py' as const
export const EXPERIMENT_TASK_PATH = /^tasks\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/u

export type CadDocumentType = 'experiment'

export type ExperimentSourceBundle = Readonly<{
  formatVersion: typeof EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION
  files: Readonly<Record<string, string>>
}>

export type ExperimentSourceDocument = Readonly<{
  kind: 'experiment'
  formatVersion: typeof CAD_SOURCE_FORMAT_VERSION
  apiVersion: 7 | typeof CAD_SOURCE_API_VERSION
  sourceBundle: ExperimentSourceBundle
}>

export type CadSourceDocument = ExperimentSourceDocument

export type CadEvaluationInput = Readonly<{
  document: ExperimentSourceDocument
  vars: Readonly<Record<string, Tensor>>
}>

function sourceBytes(source: string) {
  return new TextEncoder().encode(source).byteLength
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertSourceText(source: unknown, path: string) {
  if (typeof source !== 'string') throw new CadModelError(`${path} must contain text.`)
  const encoded = new TextEncoder().encode(source)
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== source) {
    throw new CadModelError(`${path} must contain valid UTF-8 text.`)
  }
  if (encoded.byteLength > MAX_CAD_SOURCE_BYTES) {
    throw new CadModelError(`${path} exceeds ${MAX_CAD_SOURCE_BYTES} bytes.`)
  }
}

export function experimentTaskName(path: string) {
  return EXPERIMENT_TASK_PATH.exec(path)?.[1] ?? null
}

export function experimentTaskPaths(bundle: ExperimentSourceBundle) {
  return Object.keys(bundle.files)
    .filter((path) => experimentTaskName(path) !== null)
    .sort(compareCanonicalText)
}

export function assertExperimentSourceBundle(value: unknown): asserts value is ExperimentSourceBundle {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError('Experiment source bundle must be a plain object.')
  }
  const bundle = value as Readonly<{
    formatVersion?: unknown
    files?: unknown
  }>
  const unknownKey = Object.keys(value).find((key) => !['files', 'formatVersion'].includes(key))
  if (unknownKey) throw new CadModelError(`Experiment source bundle.${unknownKey} is not allowed.`)
  if (bundle.formatVersion !== EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION) {
    throw new CadModelError('Only Experiment source bundle format version 6 is supported.')
  }
  if (
    typeof bundle.files !== 'object' ||
    bundle.files === null ||
    Array.isArray(bundle.files) ||
    Object.getPrototypeOf(bundle.files) !== Object.prototype
  ) {
    throw new CadModelError('Experiment source bundle files must be a plain object.')
  }
  const paths = Object.keys(bundle.files)
  assertExperimentSourcePaths(paths)
  if (
    !paths.includes(EXPERIMENT_ENTRY_PATH) ||
    !paths.includes(EXPERIMENT_GEOMETRY_PATH) ||
    !paths.includes(EXPERIMENT_MATERIAL_PATH) ||
    !paths.includes(EXPERIMENT_SIMULATION_PATH)
  ) {
    throw new CadModelError(
      'Experiment source bundle requires experiment.tsx, geometry.tsx, material.tsx, and simulate.py.',
    )
  }
  const files = bundle.files as Record<string, unknown>
  paths.forEach((path) => assertSourceText(files[path], `Experiment source ${path}`))
  if (paths.reduce((total, path) => total + sourceBytes(files[path] as string), 0) > MAX_CAD_SOURCE_BYTES) {
    throw new CadModelError(`Experiment source bundle exceeds ${MAX_CAD_SOURCE_BYTES} bytes.`)
  }
  if (!(files[EXPERIMENT_ENTRY_PATH] as string).trim()) {
    throw new CadModelError('Experiment source experiment.tsx must not be empty.')
  }
  if (!(files[EXPERIMENT_SIMULATION_PATH] as string).trim()) {
    throw new CadModelError('Experiment source simulate.py must not be empty.')
  }
}

function canonicalFiles(files: Readonly<Record<string, string>>) {
  return Object.freeze(
    Object.fromEntries(Object.entries(files).sort(([left], [right]) => compareCanonicalText(left, right))),
  )
}

export function createExperimentSourceBundle(files: Readonly<Record<string, string>>): ExperimentSourceBundle {
  const bundle = Object.freeze({
    formatVersion: EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION,
    files: canonicalFiles({
      ...files,
      [EXPERIMENT_GEOMETRY_PATH]: files[EXPERIMENT_GEOMETRY_PATH] ?? 'export {}\n',
      [EXPERIMENT_MATERIAL_PATH]: files[EXPERIMENT_MATERIAL_PATH] ?? 'export {}\n',
    }),
  })
  assertExperimentSourceBundle(bundle)
  return bundle
}

function replaceBundleFiles(files: Readonly<Record<string, string>>) {
  return createExperimentSourceBundle(files)
}

export function assertCadSourceDocument(value: unknown): asserts value is ExperimentSourceDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError('Experiment source document must be a plain object.')
  }
  const document = value as Partial<ExperimentSourceDocument>
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'formatVersion', 'kind', 'sourceBundle'].includes(key),
  )
  if (unknownKey) throw new CadModelError(`Experiment source document.${unknownKey} is not allowed.`)
  if (
    document.kind !== 'experiment' ||
    document.formatVersion !== CAD_SOURCE_FORMAT_VERSION ||
    (document.apiVersion !== 7 && document.apiVersion !== CAD_SOURCE_API_VERSION)
  ) {
    throw new CadModelError('Only Experiment source format version 2 and API version 7 or 8 are supported.')
  }
  assertExperimentSourceBundle(document.sourceBundle)
}

export function createCadSourceDocument(
  kind: 'experiment',
  sourceBundle: ExperimentSourceBundle,
): ExperimentSourceDocument {
  const document = Object.freeze({
    kind,
    formatVersion: CAD_SOURCE_FORMAT_VERSION,
    apiVersion: CAD_SOURCE_API_VERSION,
    sourceBundle,
  })
  assertCadSourceDocument(document)
  return document
}

export function cadSource(document: ExperimentSourceDocument) {
  assertCadSourceDocument(document)
  return document.sourceBundle.files[EXPERIMENT_ENTRY_PATH]
}

export function experimentSourceFile(document: ExperimentSourceDocument, path: string) {
  assertCadSourceDocument(document)
  const source = document.sourceBundle.files[path]
  if (source === undefined) throw new CadModelError(`Experiment source file does not exist: ${path}`)
  return source
}

export function updateCadSource(document: ExperimentSourceDocument, source: string) {
  return updateExperimentSourceFile(document, EXPERIMENT_ENTRY_PATH, source)
}

export function updateExperimentSourceFile(
  document: ExperimentSourceDocument,
  path: string,
  source: string,
): ExperimentSourceDocument {
  if (!(path in document.sourceBundle.files)) {
    throw new CadModelError(`Experiment source file does not exist: ${path}`)
  }
  return createCadSourceDocument('experiment', replaceBundleFiles({ ...document.sourceBundle.files, [path]: source }))
}

export function addExperimentTask(document: ExperimentSourceDocument, taskName: string, source: string) {
  const path = `tasks/${taskName}.tsx`
  if (experimentTaskName(path) !== taskName) throw new CadModelError('Task name is invalid.')
  if (path in document.sourceBundle.files) throw new CadModelError(`Task already exists: ${taskName}`)
  return createCadSourceDocument('experiment', replaceBundleFiles({ ...document.sourceBundle.files, [path]: source }))
}

export function addExperimentSourceFile(document: ExperimentSourceDocument, path: string, source: string) {
  assertExperimentSourcePath(path)
  if (path in document.sourceBundle.files) throw new CadModelError(`Experiment source file already exists: ${path}`)
  return createCadSourceDocument('experiment', replaceBundleFiles({ ...document.sourceBundle.files, [path]: source }))
}

export function removeExperimentTask(document: ExperimentSourceDocument, taskName: string) {
  const path = `tasks/${taskName}.tsx`
  if (!(path in document.sourceBundle.files)) throw new CadModelError(`Task does not exist: ${taskName}`)
  const files = { ...document.sourceBundle.files }
  delete files[path]
  return createCadSourceDocument('experiment', replaceBundleFiles(files))
}

export function removeExperimentSourceFile(document: ExperimentSourceDocument, path: string) {
  if (!(path in document.sourceBundle.files)) throw new CadModelError(`Experiment source file does not exist: ${path}`)
  if (
    path === EXPERIMENT_ENTRY_PATH ||
    path === EXPERIMENT_GEOMETRY_PATH ||
    path === EXPERIMENT_MATERIAL_PATH ||
    path === EXPERIMENT_SIMULATION_PATH
  ) {
    throw new CadModelError(`Required Experiment source file cannot be removed: ${path}`)
  }
  const files = { ...document.sourceBundle.files }
  delete files[path]
  return createCadSourceDocument('experiment', replaceBundleFiles(files))
}

export async function cadSourceHash(document: ExperimentSourceDocument) {
  assertCadSourceDocument(document)
  const sourceBundle = {
    files: Object.fromEntries(
      Object.entries(document.sourceBundle.files).sort(([left], [right]) => compareCanonicalText(left, right)),
    ),
    formatVersion: document.sourceBundle.formatVersion,
  }
  const input = JSON.stringify(sourceBundle)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
