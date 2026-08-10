import { CadModelError } from '../model/core'
import type { Tensor } from '../model/types'

export const CAD_SOURCE_FORMAT_VERSION = 1 as const
export const CAD_SOURCE_API_VERSION = 4 as const
export const EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION = 1 as const
export const MAX_CAD_SOURCE_BYTES = 1024 * 1024

export const EXPERIMENT_ENTRY_PATH = 'experiment.tsx' as const
export const EXPERIMENT_SIMULATION_PATH = 'simulate.py' as const
export const EXPERIMENT_TASK_PATH = /^tasks\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/u

export type CadDocumentType = 'structure' | 'experiment'

export type ExperimentSourceBundle = Readonly<{
  formatVersion: typeof EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION
  files: Readonly<Record<string, string>>
}>

type CadSourceDocumentBase = Readonly<{
  formatVersion: typeof CAD_SOURCE_FORMAT_VERSION
  apiVersion: typeof CAD_SOURCE_API_VERSION
  realizationSeed: number
}>

export type StructureSourceDocument = CadSourceDocumentBase &
  Readonly<{
    kind: 'structure'
    source: string
  }>

export type ExperimentSourceDocument = CadSourceDocumentBase &
  Readonly<{
    kind: 'experiment'
    sourceBundle: ExperimentSourceBundle
  }>

export type CadSourceDocument = StructureSourceDocument | ExperimentSourceDocument

export type CadEvaluationInput = Readonly<{
  document: CadSourceDocument
  vars?: Readonly<Record<string, Tensor>>
  seed: number
}>

function sourceBytes(source: string) {
  return new TextEncoder().encode(source).byteLength
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
    .sort((left, right) => left.localeCompare(right))
}

export function assertExperimentSourceBundle(value: unknown): asserts value is ExperimentSourceBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Experiment source bundle must be an object.')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CadModelError('Experiment source bundle must be a plain object.')
  }
  const bundle = value as Partial<ExperimentSourceBundle>
  const unknownKey = Object.keys(value).find((key) => !['files', 'formatVersion'].includes(key))
  if (unknownKey) throw new CadModelError(`Experiment source bundle.${unknownKey} is not allowed.`)
  if (bundle.formatVersion !== EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION) {
    throw new CadModelError('Only Experiment source bundle format version 1 is supported.')
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
  const invalidPath = paths.find(
    (path) =>
      path !== EXPERIMENT_ENTRY_PATH && path !== EXPERIMENT_SIMULATION_PATH && experimentTaskName(path) === null,
  )
  if (invalidPath) throw new CadModelError(`Experiment source file path is not allowed: ${invalidPath}`)
  if (!paths.includes(EXPERIMENT_ENTRY_PATH) || !paths.includes(EXPERIMENT_SIMULATION_PATH)) {
    throw new CadModelError('Experiment source bundle requires experiment.tsx and simulate.py.')
  }
  const taskPaths = paths.filter((path) => experimentTaskName(path) !== null)
  if (taskPaths.length === 0) throw new CadModelError('Experiment source bundle requires at least one Task file.')
  paths.forEach((path) => assertSourceText(bundle.files![path], `Experiment source ${path}`))
  if (paths.reduce((total, path) => total + sourceBytes(bundle.files![path]), 0) > MAX_CAD_SOURCE_BYTES) {
    throw new CadModelError(`Experiment source bundle exceeds ${MAX_CAD_SOURCE_BYTES} bytes.`)
  }
  if (!bundle.files[EXPERIMENT_ENTRY_PATH].trim()) {
    throw new CadModelError('Experiment source experiment.tsx must not be empty.')
  }
  if (!bundle.files[EXPERIMENT_SIMULATION_PATH].trim()) {
    throw new CadModelError('Experiment source simulate.py must not be empty.')
  }
}

export function createExperimentSourceBundle(files: Readonly<Record<string, string>>): ExperimentSourceBundle {
  const bundle = Object.freeze({
    formatVersion: EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION,
    files: Object.freeze(
      Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
    ),
  })
  assertExperimentSourceBundle(bundle)
  return bundle
}

export function assertCadSourceDocument(value: unknown): asserts value is CadSourceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('CAD source document must be an object.')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CadModelError('CAD source document must be a plain object.')
  }
  const document = value as Partial<CadSourceDocument>
  const allowedKeys =
    document.kind === 'structure'
      ? ['apiVersion', 'formatVersion', 'kind', 'realizationSeed', 'source']
      : ['apiVersion', 'formatVersion', 'kind', 'realizationSeed', 'sourceBundle']
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new CadModelError(`CAD source document.${unknownKey} is not allowed.`)
  if (document.kind !== 'structure' && document.kind !== 'experiment') {
    throw new CadModelError('CAD source document kind must be structure or experiment.')
  }
  if (document.formatVersion !== CAD_SOURCE_FORMAT_VERSION || document.apiVersion !== CAD_SOURCE_API_VERSION) {
    throw new CadModelError('Only CAD source format version 1 and API version 4 are supported.')
  }
  if (!Number.isSafeInteger(document.realizationSeed) || document.realizationSeed! < 0) {
    throw new CadModelError('CAD source realizationSeed must be a non-negative safe integer.')
  }
  if (document.kind === 'structure') assertSourceText(document.source, 'CAD source document source')
  else assertExperimentSourceBundle((document as Partial<ExperimentSourceDocument>).sourceBundle)
}

export function createRealizationSeed() {
  const seed = new Uint32Array(1)
  globalThis.crypto.getRandomValues(seed)
  return seed[0]
}

export function createCadSourceDocument(
  kind: 'structure',
  source: string,
  realizationSeed?: number,
): StructureSourceDocument
export function createCadSourceDocument(
  kind: 'experiment',
  sourceBundle: ExperimentSourceBundle,
  realizationSeed?: number,
): ExperimentSourceDocument
export function createCadSourceDocument(
  kind: CadDocumentType,
  source: string | ExperimentSourceBundle,
  realizationSeed = createRealizationSeed(),
): CadSourceDocument {
  const document = Object.freeze({
    kind,
    formatVersion: CAD_SOURCE_FORMAT_VERSION,
    apiVersion: CAD_SOURCE_API_VERSION,
    realizationSeed,
    ...(kind === 'structure' ? { source } : { sourceBundle: source }),
  })
  assertCadSourceDocument(document)
  return document
}

export function cadSource(document: CadSourceDocument) {
  assertCadSourceDocument(document)
  return document.kind === 'structure' ? document.source : document.sourceBundle.files[EXPERIMENT_ENTRY_PATH]
}

export function experimentSourceFile(document: ExperimentSourceDocument, path: string) {
  assertCadSourceDocument(document)
  const source = document.sourceBundle.files[path]
  if (source === undefined) throw new CadModelError(`Experiment source file does not exist: ${path}`)
  return source
}

export function updateCadSource(document: CadSourceDocument, source: string): CadSourceDocument {
  if (document.kind === 'structure') {
    const updated = Object.freeze({ ...document, source })
    assertCadSourceDocument(updated)
    return updated
  }
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
  return createCadSourceDocument(
    'experiment',
    createExperimentSourceBundle({ ...document.sourceBundle.files, [path]: source }),
    document.realizationSeed,
  )
}

export function addExperimentTask(
  document: ExperimentSourceDocument,
  taskName: string,
  source: string,
): ExperimentSourceDocument {
  const path = `tasks/${taskName}.tsx`
  if (experimentTaskName(path) !== taskName) throw new CadModelError('Task name is invalid.')
  if (path in document.sourceBundle.files) throw new CadModelError(`Task already exists: ${taskName}`)
  return createCadSourceDocument(
    'experiment',
    createExperimentSourceBundle({ ...document.sourceBundle.files, [path]: source }),
    document.realizationSeed,
  )
}

export function removeExperimentTask(document: ExperimentSourceDocument, taskName: string): ExperimentSourceDocument {
  const path = `tasks/${taskName}.tsx`
  if (!(path in document.sourceBundle.files)) throw new CadModelError(`Task does not exist: ${taskName}`)
  if (experimentTaskPaths(document.sourceBundle).length === 1) {
    throw new CadModelError('Experiment source bundle requires at least one Task file.')
  }
  const files = { ...document.sourceBundle.files }
  delete files[path]
  return createCadSourceDocument('experiment', createExperimentSourceBundle(files), document.realizationSeed)
}

export function rerollCadSourceDocument(document: CadSourceDocument): CadSourceDocument {
  assertCadSourceDocument(document)
  const generatedSeed = createRealizationSeed()
  const realizationSeed = generatedSeed === document.realizationSeed ? (generatedSeed + 1) >>> 0 : generatedSeed
  const rerolled = Object.freeze({ ...document, realizationSeed })
  assertCadSourceDocument(rerolled)
  return rerolled
}

function canonicalSource(document: CadSourceDocument) {
  if (document.kind === 'structure') return JSON.stringify({ kind: document.kind, source: document.source })
  return JSON.stringify({
    kind: document.kind,
    sourceBundle: {
      formatVersion: document.sourceBundle.formatVersion,
      files: Object.fromEntries(
        Object.entries(document.sourceBundle.files).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  })
}

export async function cadSourceHash(document: CadSourceDocument) {
  assertCadSourceDocument(document)
  const input = JSON.stringify({
    apiVersion: document.apiVersion,
    formatVersion: document.formatVersion,
    source: canonicalSource(document),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
