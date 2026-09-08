import type { Expression, ObjectExpression, ObjectMethod, ObjectProperty } from '@babel/types'
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
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  experimentTaskName,
  experimentTaskPaths,
  type ExperimentSourceBundle,
} from '../cad/source/document'
import { experimentTypeScriptPaths } from '../cad/source/moduleResolution'
import { DRAFT_TASK_KERNEL } from './draftTask'

export type CatalogSourceReferences = CatalogRuntimeSliceRequest & Readonly<{ draftTaskNames: readonly string[] }>
export type CatalogRuntimeSliceResolver = (bundle: ExperimentSourceBundle) => Promise<CatalogRuntimeSlice>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Reflect.ownKeys(value).forEach((key) => deepFreeze((value as Record<PropertyKey, unknown>)[key]))
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

const EMPTY_DRAFT_CATALOG_RUNTIME_SLICE: CatalogRuntimeSlice = deepFreeze({
  catalogRevision: 'draft-only-empty',
  solvers: [],
  quantityKinds: [],
  materialModels: [],
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

function collectFileReferences(
  path: string,
  source: string,
  policy: 'experiment' | 'geometry' | 'material' | 'module' | 'task',
) {
  const ast = parseCadSource(source, policy, path)
  const analysis = { bindings: collectSourceBindings(ast.program.body) }
  const quantityKinds = new Set<string>()
  const materialModels = new Set<string>()
  const materialConstructors = new Set(
    ast.program.body.flatMap((statement) => {
      if (statement.type !== 'ImportDeclaration' || statement.source.value !== '@caemble/core') return []
      return statement.specifiers.flatMap((specifier) => {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') return []
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        return imported === 'Material' ? [specifier.local.name] : []
      })
    }),
  )

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
      materialConstructors.has((node.callee as { name: string }).name)
    ) {
      const args = node.arguments as unknown[]
      if (args.length > 2) throw new SourceAnalysisError('Material accepts only a name and { color?, models? }.')
      if (args[1] !== undefined) {
        const options = resolveSourceBinding(
          sourceExpression(args[1], 'Material options'),
          analysis.bindings,
        ).expression
        if (options.type !== 'ObjectExpression')
          throw new SourceAnalysisError('Material options must be a fixed object literal.')
        for (const property of options.properties) {
          if (property.type !== 'ObjectProperty')
            throw new SourceAnalysisError('Material options must use explicit property names.')
          const key = propertyName(property, analysis)
          if (key === 'color') continue
          if (key !== 'models')
            throw new SourceAnalysisError(`Material.${key} is not allowed; define physical parameters inside models.`)
          const models = resolveSourceBinding(
            sourceExpression(property.value, 'Material.models'),
            analysis.bindings,
          ).expression
          if (models.type !== 'ObjectExpression')
            throw new SourceAnalysisError('Material.models must use a fixed instance map.')
          for (const instance of models.properties) {
            if (instance.type !== 'ObjectProperty')
              throw new SourceAnalysisError('Material.models must declare each model instance explicitly.')
            propertyName(instance, analysis)
            const definition = resolveSourceBinding(
              sourceExpression(instance.value, 'Model instance'),
              analysis.bindings,
            ).expression
            if (definition.type !== 'ObjectExpression')
              throw new SourceAnalysisError('Model instances must use fixed object literals.')
            const selectors = definition.properties.filter(
              (field): field is ObjectProperty =>
                field.type === 'ObjectProperty' && propertyName(field, analysis) === 'model',
            )
            if (selectors.length !== 1)
              throw new SourceAnalysisError('Each model instance must declare model exactly once.')
            materialModels.add(
              staticString(sourceExpression(selectors[0].value, 'Model identity'), analysis, 'Model identity'),
            )
          }
        }
      }
    }
    Object.entries(node).forEach(([key, child]) => {
      if (!['loc', 'start', 'end'].includes(key)) visit(child)
    })
  }
  visit(ast.program)
  return { quantityKinds, materialModels }
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
  const materialModels = new Set<string>()
  const sourceFiles = experimentTypeScriptPaths(bundle.files).map(
    (path) =>
      [
        path,
        path === EXPERIMENT_ENTRY_PATH
          ? ('experiment' as const)
          : path === EXPERIMENT_GEOMETRY_PATH
            ? ('geometry' as const)
            : path === EXPERIMENT_MATERIAL_PATH
              ? ('material' as const)
              : experimentTaskName(path) !== null
                ? ('task' as const)
                : ('module' as const),
      ] as const,
  )
  sourceFiles.forEach(([path, policy]) => {
    const found = collectFileReferences(path, bundle.files[path], policy)
    found.quantityKinds.forEach((name) => quantityKinds.add(name))
    found.materialModels.forEach((key) => materialModels.add(key))
  })
  return Object.freeze({
    solvers: Object.freeze(solvers),
    draftTaskNames: Object.freeze(draftTaskNames),
    quantityKinds: Object.freeze([...quantityKinds].sort()),
    materialModels: Object.freeze([...materialModels].sort()),
  })
}

export function createCachedCatalogRuntimeSliceResolver(
  fetchRuntimeSlice: (request: CatalogRuntimeSliceRequest) => Promise<CatalogRuntimeSlice>,
): CatalogRuntimeSliceResolver {
  const sliceCache = new Map<string, Promise<CatalogRuntimeSlice>>()
  return async (bundle) => {
    const references = extractCatalogSourceReferences(bundle)
    if (
      references.solvers.length === 0 &&
      references.quantityKinds.length === 0 &&
      references.materialModels.length === 0
    ) {
      return EMPTY_DRAFT_CATALOG_RUNTIME_SLICE
    }
    const request: CatalogRuntimeSliceRequest = Object.freeze({
      solvers: references.solvers,
      quantityKinds: references.quantityKinds,
      materialModels: references.materialModels,
    })
    const key = JSON.stringify(request)
    let cached = sliceCache.get(key)
    if (!cached) {
      cached = fetchRuntimeSlice(request)
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
}
