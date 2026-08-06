import { CadModelError } from '../model/core'
import type { Tensor } from '../model/types'

export const CAD_SOURCE_FORMAT_VERSION = 1 as const
export const CAD_SOURCE_API_VERSION = 3 as const
export const MAX_CAD_SOURCE_BYTES = 1024 * 1024

export type CadDocumentType = 'structure' | 'experiment'

export type CadSourceDocument = Readonly<{
  kind: CadDocumentType
  formatVersion: typeof CAD_SOURCE_FORMAT_VERSION
  apiVersion: typeof CAD_SOURCE_API_VERSION
  source: string
  realizationSeed: number
  simulationCode?: string | null
}>

export type CadEvaluationInput = Readonly<{
  document: CadSourceDocument
  vars?: Readonly<Record<string, Tensor>>
  seed: number
}>

export function assertCadSourceDocument(value: unknown): asserts value is CadSourceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('CAD source document must be an object.')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CadModelError('CAD source document must be a plain object.')
  }
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'formatVersion', 'kind', 'realizationSeed', 'simulationCode', 'source'].includes(key),
  )
  if (unknownKey) throw new CadModelError(`CAD source document.${unknownKey} is not allowed.`)

  const document = value as Partial<CadSourceDocument>
  if (document.kind !== 'structure' && document.kind !== 'experiment') {
    throw new CadModelError('CAD source document kind must be structure or experiment.')
  }
  if (document.formatVersion !== CAD_SOURCE_FORMAT_VERSION || document.apiVersion !== CAD_SOURCE_API_VERSION) {
    throw new CadModelError('Only CAD source format version 1 and API version 3 are supported.')
  }
  if (!Number.isSafeInteger(document.realizationSeed) || document.realizationSeed! < 0) {
    throw new CadModelError('CAD source realizationSeed must be a non-negative safe integer.')
  }
  if (typeof document.source !== 'string') {
    throw new CadModelError('CAD source document source must contain text.')
  }
  if (new TextEncoder().encode(document.source).byteLength > MAX_CAD_SOURCE_BYTES) {
    throw new CadModelError(`CAD source exceeds ${MAX_CAD_SOURCE_BYTES} bytes.`)
  }
  if (document.kind === 'structure' && document.simulationCode !== undefined) {
    throw new CadModelError('Structure source cannot contain Python simulation code.')
  }
  if (
    document.kind === 'experiment' &&
    document.simulationCode !== undefined &&
    document.simulationCode !== null &&
    typeof document.simulationCode !== 'string'
  ) {
    throw new CadModelError('Experiment Python simulation code must contain text or be null.')
  }
  if (
    typeof document.simulationCode === 'string' &&
    new TextEncoder().encode(document.simulationCode).byteLength > MAX_CAD_SOURCE_BYTES
  ) {
    throw new CadModelError(`Experiment Python simulation code exceeds ${MAX_CAD_SOURCE_BYTES} bytes.`)
  }
}

export function createRealizationSeed() {
  const seed = new Uint32Array(1)
  globalThis.crypto.getRandomValues(seed)
  return seed[0]
}

export function createCadSourceDocument(
  kind: CadDocumentType,
  source: string,
  realizationSeed = createRealizationSeed(),
  simulationCode?: string | null,
): CadSourceDocument {
  const document = Object.freeze({
    kind,
    formatVersion: CAD_SOURCE_FORMAT_VERSION,
    apiVersion: CAD_SOURCE_API_VERSION,
    source,
    realizationSeed,
    ...(kind === 'experiment' && simulationCode !== undefined ? { simulationCode } : {}),
  })
  assertCadSourceDocument(document)
  return document
}

export function cadSource(document: CadSourceDocument) {
  assertCadSourceDocument(document)
  return document.source
}

export function updateCadSource(document: CadSourceDocument, source: string): CadSourceDocument {
  const updated = Object.freeze({ ...document, source })
  assertCadSourceDocument(updated)
  return updated
}

export function updateCadSimulationCode(document: CadSourceDocument, simulationCode: string): CadSourceDocument {
  if (document.kind !== 'experiment') {
    throw new CadModelError('Only Experiment documents can contain Python simulation code.')
  }
  const updated = Object.freeze({ ...document, simulationCode })
  assertCadSourceDocument(updated)
  return updated
}

export function rerollCadSourceDocument(document: CadSourceDocument): CadSourceDocument {
  assertCadSourceDocument(document)
  const generatedSeed = createRealizationSeed()
  const realizationSeed = generatedSeed === document.realizationSeed ? (generatedSeed + 1) >>> 0 : generatedSeed
  const rerolled = Object.freeze({ ...document, realizationSeed })
  assertCadSourceDocument(rerolled)
  return rerolled
}

export async function cadSourceHash(document: CadSourceDocument) {
  assertCadSourceDocument(document)
  const input = JSON.stringify({
    apiVersion: document.apiVersion,
    formatVersion: document.formatVersion,
    kind: document.kind,
    source: document.source,
    ...(document.kind === 'experiment' ? { simulationCode: document.simulationCode ?? null } : {}),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
