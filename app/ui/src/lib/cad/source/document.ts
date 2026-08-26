import type { Tensor } from '../model/types'

export const EXPERIMENT_ENTRY_PATH = 'experiment.tsx' as const
export const EXPERIMENT_GEOMETRY_PATH = 'geometry.tsx' as const
export const EXPERIMENT_MATERIAL_PATH = 'material.tsx' as const
export const EXPERIMENT_SIMULATION_PATH = 'simulate.py' as const
export const EXPERIMENT_TASK_PATH = /^tasks\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/u

export type CadDocumentType = 'experiment'
export type ExperimentSourceBundle = Readonly<{ files: Readonly<Record<string, string>> }>
export type ExperimentSourceDocument = Readonly<{
  kind: 'experiment'
  sourceBundle: ExperimentSourceBundle
}>
export type CadSourceDocument = ExperimentSourceDocument
export type CadEvaluationInput = Readonly<{
  document: ExperimentSourceDocument
  vars: Readonly<Record<string, Tensor>>
}>

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalFiles(files: Readonly<Record<string, string>>) {
  return Object.freeze(
    Object.fromEntries(Object.entries(files).sort(([left], [right]) => compareCanonicalText(left, right))),
  )
}

export function experimentTaskName(path: string) {
  return EXPERIMENT_TASK_PATH.exec(path)?.[1] ?? null
}

export function experimentTaskPaths(bundle: ExperimentSourceBundle) {
  return Object.keys(bundle.files)
    .filter((path) => experimentTaskName(path) !== null)
    .sort(compareCanonicalText)
}

export function createExperimentSourceBundle(files: Readonly<Record<string, string>>): ExperimentSourceBundle {
  return Object.freeze({
    files: canonicalFiles({
      ...files,
      [EXPERIMENT_GEOMETRY_PATH]: files[EXPERIMENT_GEOMETRY_PATH] ?? 'export {}\n',
      [EXPERIMENT_MATERIAL_PATH]: files[EXPERIMENT_MATERIAL_PATH] ?? 'export {}\n',
    }),
  })
}

export function createCadSourceDocument(
  kind: 'experiment',
  sourceBundle: ExperimentSourceBundle,
): ExperimentSourceDocument {
  return Object.freeze({ kind, sourceBundle })
}

export function cadSource(document: ExperimentSourceDocument) {
  return document.sourceBundle.files[EXPERIMENT_ENTRY_PATH]
}

export function experimentSourceFile(document: ExperimentSourceDocument, path: string) {
  return document.sourceBundle.files[path]
}

export function updateCadSource(document: ExperimentSourceDocument, source: string) {
  return updateExperimentSourceFile(document, EXPERIMENT_ENTRY_PATH, source)
}

export function updateExperimentSourceFile(
  document: ExperimentSourceDocument,
  path: string,
  source: string,
): ExperimentSourceDocument {
  return createCadSourceDocument('experiment', createExperimentSourceBundle({ ...document.sourceBundle.files, [path]: source }))
}

export function addExperimentTask(document: ExperimentSourceDocument, taskName: string, source: string) {
  return addExperimentSourceFile(document, `tasks/${taskName}.tsx`, source)
}

export function addExperimentSourceFile(document: ExperimentSourceDocument, path: string, source: string) {
  return createCadSourceDocument('experiment', createExperimentSourceBundle({ ...document.sourceBundle.files, [path]: source }))
}

export function removeExperimentTask(document: ExperimentSourceDocument, taskName: string) {
  return removeExperimentSourceFile(document, `tasks/${taskName}.tsx`)
}

export function removeExperimentSourceFile(document: ExperimentSourceDocument, path: string) {
  const files = { ...document.sourceBundle.files }
  delete files[path]
  return createCadSourceDocument('experiment', createExperimentSourceBundle(files))
}

export async function cadSourceHash(document: ExperimentSourceDocument) {
  const sourceBundle = {
    files: Object.fromEntries(
      Object.entries(document.sourceBundle.files).sort(([left], [right]) => compareCanonicalText(left, right)),
    ),
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sourceBundle)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
