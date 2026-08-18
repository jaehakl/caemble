import type { Expression, ObjectExpression, ObjectMethod, ObjectProperty } from '@babel/types'
import { catalogApi } from '@/api/catalog'
import type { CatalogRuntimeSlice, CatalogRuntimeSliceRequest } from '@/contracts/catalog'
import {
  analyzeTaskSource,
  collectSourceBindings,
  parseCadSource,
  resolveSourceBinding,
  sourceExpression,
  type SourceAnalysis,
  SourceAnalysisError,
} from '../cad/source/sourceAnalysis'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  experimentTaskName,
  experimentTaskPaths,
  type ExperimentSourceBundle,
} from '../cad/source/document'
import { DRAFT_TASK_KERNEL } from './draftTask'

export type CatalogSourceReferences = CatalogRuntimeSliceRequest & Readonly<{ draftTaskNames: readonly string[] }>
const sliceCache = new Map<string, Promise<CatalogRuntimeSlice>>()

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Reflect.ownKeys(value).forEach((key) => deepFreeze((value as Record<PropertyKey, unknown>)[key]))
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

const EMPTY_DRAFT_CATALOG_RUNTIME_SLICE: CatalogRuntimeSlice = deepFreeze({
  schemaVersion: 1,
  catalogRevision: 'draft-only-empty-v1',
  solvers: [],
  quantityKinds: [],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
})

function propertyName(property: ObjectProperty | ObjectMethod, analysis: Pick<SourceAnalysis, 'bindings'>) {
  const key = property.key
  if (!property.computed && key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  if (property.computed && property.type === 'ObjectProperty') {
    return staticString(sourceExpression(key, 'Catalog object key'), analysis, 'Catalog object key')
  }
  throw new SourceAnalysisError('Catalog object keys must use fixed string names.')
}

function staticString(expression: Expression, analysis: Pick<SourceAnalysis, 'bindings'>, label: string) {
  const resolved = resolveSourceBinding(expression, analysis.bindings).expression
  if (resolved.type === 'StringLiteral') return resolved.value
  if (resolved.type === 'TemplateLiteral' && resolved.expressions.length === 0) {
    return resolved.quasis[0]?.value.cooked ?? resolved.quasis[0]?.value.raw ?? ''
  }
  throw new SourceAnalysisError(`${label} must be a fixed string literal or a directly connected top-level const.`)
}

function objectProperty(object: ObjectExpression, name: string, analysis: SourceAnalysis) {
  const matches = object.properties.filter(
    (property): property is ObjectProperty =>
      property.type === 'ObjectProperty' && propertyName(property, analysis) === name,
  )
  if (matches.length !== 1) throw new SourceAnalysisError(`${analysis.factoryName} options.${name} must occur once.`)
  return resolveSourceBinding(sourceExpression(matches[0].value, name), analysis.bindings).expression
}

function taskSolver(analysis: SourceAnalysis) {
  const kernel = objectProperty(analysis.options, 'kernel', analysis)
  if (kernel.type !== 'ObjectExpression') {
    throw new SourceAnalysisError('Task kernel must be a fixed object literal.')
  }
  const name = objectProperty(kernel, 'name', analysis)
  const version = objectProperty(kernel, 'version', analysis)
  return Object.freeze({
    name: staticString(name, analysis, 'Task kernel.name'),
    version: staticString(version, analysis, 'Task kernel.version'),
  })
}

function collectFileReferences(source: string, policy: 'experiment' | 'material' | 'task') {
  const ast = parseCadSource(source, policy)
  const analysis = { bindings: collectSourceBindings(ast.program.body) }
  const quantityKinds = new Set<string>()
  const materialParameters = new Set<string>()
  const materialModels = new Set<string>()

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as Record<string, unknown>
    if (node.type === 'ObjectProperty') {
      const property = node as unknown as ObjectProperty
      const directName =
        !property.computed && property.key.type === 'Identifier'
          ? property.key.name
          : property.key.type === 'StringLiteral'
            ? property.key.value
            : null
      if (directName === 'quantityKind') {
        quantityKinds.add(staticString(sourceExpression(property.value, 'quantityKind'), analysis, 'quantityKind'))
      }
    }
    if (
      node.type === 'NewExpression' &&
      (node.callee as { type?: string; name?: string })?.type === 'Identifier' &&
      (node.callee as { name?: string }).name === 'Material'
    ) {
      const args = node.arguments as unknown[]
      const variables = args.length >= 3 ? args[2] : args.length === 2 ? args[1] : undefined
      if (variables !== undefined) {
        const expression = resolveSourceBinding(
          sourceExpression(variables, 'Material variables or source selector'),
          analysis.bindings,
        ).expression
        if (
          args.length === 2 &&
          (expression.type === 'StringLiteral' ||
            (expression.type === 'TemplateLiteral' && expression.expressions.length === 0))
        ) {
          Object.entries(node).forEach(([key, child]) => {
            if (!['loc', 'start', 'end'].includes(key)) visit(child)
          })
          return
        }
        if (expression.type !== 'ObjectExpression') {
          throw new SourceAnalysisError(
            'Material variables must use an object literal so catalog keys are known before evaluation.',
          )
        }
        expression.properties.forEach((property) => {
          if (property.type === 'SpreadElement') {
            throw new SourceAnalysisError('Material variables cannot spread catalog keys; write each key directly.')
          }
          const key = propertyName(property, analysis)
          if (key.startsWith('model.')) materialModels.add(key)
          else if (key.includes('.')) materialParameters.add(key)
        })
      }
    }
    Object.entries(node).forEach(([key, child]) => {
      if (!['loc', 'start', 'end'].includes(key)) visit(child)
    })
  }
  visit(ast.program)
  return { quantityKinds, materialParameters, materialModels }
}

export function extractCatalogSourceReferences(bundle: ExperimentSourceBundle): CatalogSourceReferences {
  const taskReferences = experimentTaskPaths(bundle).map((path) => ({
    taskName: experimentTaskName(path)!,
    solver: taskSolver(analyzeTaskSource(bundle.files[path])),
  }))
  const solvers = taskReferences
    .filter(({ solver }) => solver.name !== DRAFT_TASK_KERNEL.name || solver.version !== DRAFT_TASK_KERNEL.version)
    .map(({ solver }) => solver)
  const draftTaskNames = taskReferences
    .filter(({ solver }) => solver.name === DRAFT_TASK_KERNEL.name && solver.version === DRAFT_TASK_KERNEL.version)
    .map(({ taskName }) => taskName)
  const quantityKinds = new Set<string>()
  const materialParameters = new Set<string>()
  const materialModels = new Set<string>()
  const sourceFiles: readonly (readonly [string, 'experiment' | 'material' | 'task'])[] = [
    [EXPERIMENT_ENTRY_PATH, 'experiment' as const],
    [EXPERIMENT_MATERIAL_PATH, 'material' as const],
    ...experimentTaskPaths(bundle).map((path) => [path, 'task' as const] as const),
  ]
  sourceFiles.forEach(([path, policy]) => {
    const found = collectFileReferences(bundle.files[path], policy)
    found.quantityKinds.forEach((name) => quantityKinds.add(name))
    found.materialParameters.forEach((key) => materialParameters.add(key))
    found.materialModels.forEach((key) => materialModels.add(key))
  })
  return Object.freeze({
    solvers: Object.freeze(solvers),
    draftTaskNames: Object.freeze(draftTaskNames),
    quantityKinds: Object.freeze([...quantityKinds].sort()),
    materialParameters: Object.freeze([...materialParameters].sort()),
    materialModels: Object.freeze([...materialModels].sort()),
  })
}

export async function fetchCatalogRuntimeSlice(bundle: ExperimentSourceBundle): Promise<CatalogRuntimeSlice> {
  const references = extractCatalogSourceReferences(bundle)
  if (
    references.draftTaskNames.length > 0 &&
    references.solvers.length === 0 &&
    references.quantityKinds.length === 0 &&
    references.materialParameters.length === 0 &&
    references.materialModels.length === 0
  ) {
    return EMPTY_DRAFT_CATALOG_RUNTIME_SLICE
  }
  const request: CatalogRuntimeSliceRequest = Object.freeze({
    solvers: references.solvers,
    quantityKinds: references.quantityKinds,
    materialParameters: references.materialParameters,
    materialModels: references.materialModels,
  })
  const key = JSON.stringify(request)
  let cached = sliceCache.get(key)
  if (!cached) {
    cached = catalogApi
      .runtimeSlice(request)
      .then(deepFreeze)
      .catch((error) => {
        sliceCache.delete(key)
        throw error
      })
    sliceCache.set(key, cached)
    if (sliceCache.size > 32) sliceCache.delete(sliceCache.keys().next().value!)
  }
  return cached
}
