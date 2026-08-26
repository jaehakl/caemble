import { CadModelError } from '../model/errors'

const sourceSegmentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u

export function isExperimentTypeScriptPath(path: string) {
  return !path.endsWith('.d.ts') && (path.endsWith('.ts') || path.endsWith('.tsx'))
}

export function assertExperimentSourcePath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\')
  ) {
    throw new CadModelError(`Experiment source file path is invalid: ${String(path)}`)
  }
  const segments = path.split('/')
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..' || !sourceSegmentPattern.test(segment),
    )
  ) {
    throw new CadModelError(`Experiment source file path is invalid: ${path}`)
  }
  if (path !== 'simulate.py' && !isExperimentTypeScriptPath(path)) {
    throw new CadModelError(`Experiment source file type is not supported: ${path}`)
  }
}

export function assertExperimentSourcePaths(paths: readonly string[]) {
  const folded = new Map<string, string>()
  paths.forEach((path) => {
    assertExperimentSourcePath(path)
    const key = path.toLocaleLowerCase('en-US')
    const existing = folded.get(key)
    if (existing !== undefined && existing !== path) {
      throw new CadModelError(`Experiment source paths differ only by case: ${existing}, ${path}`)
    }
    folded.set(key, path)
  })
}

export function experimentTypeScriptPaths(files: Readonly<Record<string, unknown>>) {
  return Object.keys(files)
    .filter(isExperimentTypeScriptPath)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function normalizedRelativeTarget(importerPath: string, specifier: string) {
  if ((!specifier.startsWith('./') && !specifier.startsWith('../')) || specifier.includes('\\')) {
    throw new CadModelError(`Experiment module import must be bundle-relative: ${specifier}`)
  }
  const segments = importerPath.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new CadModelError(`Experiment module import escapes the source bundle: ${specifier}`)
      }
      segments.pop()
      continue
    }
    if (!sourceSegmentPattern.test(segment)) {
      throw new CadModelError(`Experiment module import path is invalid: ${specifier}`)
    }
    segments.push(segment)
  }
  if (segments.length === 0) throw new CadModelError(`Experiment module import path is invalid: ${specifier}`)
  return segments.join('/')
}

export function resolveExperimentModuleSpecifier(
  files: Readonly<Record<string, unknown>>,
  importerPath: string,
  specifier: string,
) {
  assertExperimentSourcePath(importerPath)
  const target = normalizedRelativeTarget(importerPath, specifier)
  const candidates = isExperimentTypeScriptPath(target)
    ? [target]
    : [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`]
  const matches = candidates.filter((candidate) => Object.prototype.hasOwnProperty.call(files, candidate))
  if (matches.length === 0) {
    throw new CadModelError(`Experiment module import is unresolved in ${importerPath}: ${specifier}`)
  }
  if (matches.length > 1) {
    throw new CadModelError(
      `Experiment module import is ambiguous in ${importerPath}: ${specifier} (${matches.join(', ')})`,
    )
  }
  return matches[0]
}
