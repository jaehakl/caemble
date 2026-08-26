import generateModule from '@babel/generator'
import { parse } from '@babel/parser'
import traverseModule, { type Binding, type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import type {
  Expression,
  File,
  FunctionDeclaration,
  FunctionExpression,
  ObjectExpression,
  ReturnStatement,
  Statement,
  TSInterfaceDeclaration,
  TSType,
  TSTypeAliasDeclaration,
} from '@babel/types'
import { resolveExperimentModuleSpecifier } from './moduleResolution'

const generate = (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule
const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule

export class SourceAnalysisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceAnalysisError'
  }
}

export type SourceAnalysis = Readonly<{
  ast: File
  bindings: ReadonlyMap<string, Expression>
  factoryName: 'defineTask' | 'experiment'
  options: ObjectExpression
}>

export type GeometrySourceAnalysis = Readonly<{
  ast: File
  exports: readonly Readonly<{
    name: string
    defaultedProps: readonly string[]
    functionRange: Readonly<{ start: number; end: number }> | null
    renderExpression: Expression | null
  }>[]
  imports: readonly Readonly<{
    exportName: string
    alias: string
    specifier: string
    specifierStart: number
    specifierEnd: number
  }>[]
}>

export type MaterialSourceAnalysis = Readonly<{
  ast: File
  exports: readonly string[]
}>

type CadSourcePolicy = 'experiment' | 'task' | 'geometry' | 'material' | 'module'

const geometrySharedProps = new Set(['children', 'id', 'materials', 'position', 'rotation', 'scale'])

function propertyName(node: t.Expression | t.PrivateName): string | null {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'StringLiteral') return node.value
  return null
}

function geometryPropNames(
  node: TSType,
  declarations: ReadonlyMap<string, TSTypeAliasDeclaration | TSInterfaceDeclaration>,
  resolving = new Set<string>(),
): readonly string[] | null {
  if (node.type === 'TSObjectKeyword') return []
  if (node.type === 'TSIntersectionType') {
    const names: string[] = []
    for (const item of node.types) {
      const resolved = geometryPropNames(item, declarations, resolving)
      if (resolved === null) return null
      names.push(...resolved)
    }
    return [...new Set(names)]
  }
  if (node.type === 'TSTypeLiteral') {
    const names = node.members.map((member) => {
      if (member.type !== 'TSPropertySignature' || member.computed) return null
      return propertyName(member.key)
    })
    return names.includes(null) ? null : (names as string[])
  }
  if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier') return null
  if (node.typeName.name === 'Readonly') {
    const parameter = node.typeParameters?.params[0]
    return parameter ? geometryPropNames(parameter, declarations, resolving) : null
  }
  const declaration = declarations.get(node.typeName.name)
  if (!declaration || resolving.has(node.typeName.name)) return null
  resolving.add(node.typeName.name)
  const names =
    declaration.type === 'TSTypeAliasDeclaration'
      ? geometryPropNames(declaration.typeAnnotation, declarations, resolving)
      : declaration.extends?.length
        ? null
        : geometryPropNames(
            t.tsTypeLiteral(declaration.body.body.map((member) => t.cloneNode(member, true))),
            declarations,
            resolving,
          )
  resolving.delete(node.typeName.name)
  return names
}

function componentPropNames(
  name: string,
  component: t.ArrowFunctionExpression | FunctionExpression | FunctionDeclaration,
  annotation: TSType | null,
  declarations: ReadonlyMap<string, TSTypeAliasDeclaration | TSInterfaceDeclaration>,
) {
  if (
    annotation?.type === 'TSTypeReference' &&
    annotation.typeName.type === 'Identifier' &&
    annotation.typeName.name === 'Geometry'
  ) {
    const propsType = annotation.typeParameters?.params[0]
    if (!propsType) return []
    const names = geometryPropNames(propsType, declarations)
    if (names === null) {
      throw new SourceAnalysisError(
        `Geometry ${name} props must use a statically enumerable inline or local object type.`,
      )
    }
    return names
  }
  const firstParameter = component.params[0]
  if (!firstParameter) return []
  if (firstParameter.type !== 'ObjectPattern') {
    throw new SourceAnalysisError(`Geometry ${name} props must use direct object destructuring.`)
  }
  const parameterType =
    firstParameter.typeAnnotation?.type === 'TSTypeAnnotation' ? firstParameter.typeAnnotation.typeAnnotation : null
  if (!parameterType) {
    return firstParameter.properties.flatMap((property) => {
      if (property.type !== 'ObjectProperty' || property.computed) return []
      const key = propertyName(property.key)
      return key && !geometrySharedProps.has(key) ? [key] : []
    })
  }
  const names = geometryPropNames(parameterType, declarations)
  if (names === null) {
    throw new SourceAnalysisError(
      `Geometry ${name} props must use a statically enumerable inline or local object type.`,
    )
  }
  return names.filter((item) => !geometrySharedProps.has(item))
}

function assertGeometryPropDefaults(
  name: string,
  component: t.ArrowFunctionExpression | FunctionExpression | FunctionDeclaration,
  annotation: TSType | null,
  declarations: ReadonlyMap<string, TSTypeAliasDeclaration | TSInterfaceDeclaration>,
) {
  const customProps = componentPropNames(name, component, annotation, declarations)
  const firstParameter = component.params[0]
  if (!firstParameter) {
    if (customProps.length) {
      throw new SourceAnalysisError(
        `Geometry ${name} must provide defaults for custom props: ${customProps.join(', ')}.`,
      )
    }
    return
  }
  if (firstParameter.type !== 'ObjectPattern') {
    throw new SourceAnalysisError(`Geometry ${name} props must use direct object destructuring.`)
  }
  const defaults = new Set<string>()
  firstParameter.properties.forEach((property) => {
    if (property.type !== 'ObjectProperty' || property.computed || !property.shorthand) {
      throw new SourceAnalysisError(`Geometry ${name} props must use direct properties with explicit defaults.`)
    }
    const key = propertyName(property.key)
    if (!key) throw new SourceAnalysisError(`Geometry ${name} prop names must be static identifiers or strings.`)
    if (geometrySharedProps.has(key)) return
    if (property.value.type !== 'AssignmentPattern' || property.value.left.type !== 'Identifier') {
      throw new SourceAnalysisError(`Geometry ${name} props must use direct properties with explicit defaults.`)
    }
    defaults.add(key)
  })
  const missing = customProps.filter((item) => !defaults.has(item))
  if (missing.length) {
    throw new SourceAnalysisError(`Geometry ${name} must provide defaults for custom props: ${missing.join(', ')}.`)
  }
}

export function unwrapSourceExpression(expression: Expression): Expression {
  if (
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TypeCastExpression'
  ) {
    return unwrapSourceExpression(expression.expression)
  }
  return expression
}

export function sourceExpression(value: unknown, label: string): Expression {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new SourceAnalysisError(`${label} could not be resolved to a source expression.`)
  }
  const nodeType = String(value.type)
  if (nodeType === 'SpreadElement' || nodeType === 'ArgumentPlaceholder') {
    throw new SourceAnalysisError(`${label} cannot use a spread or argument placeholder.`)
  }
  return value as Expression
}

export function collectSourceBindings(statements: readonly Statement[]) {
  const bindings = new Map<string, Expression>()
  statements.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') return
    statement.declarations.forEach((declaration) => {
      if (declaration.id.type !== 'Identifier' || !declaration.init) return
      bindings.set(declaration.id.name, sourceExpression(declaration.init, declaration.id.name))
    })
  })
  return bindings
}

export function resolveSourceBinding(
  expression: Expression,
  bindings: ReadonlyMap<string, Expression>,
  visited = new Set<string>(),
): { expression: Expression; bindingName?: string } {
  const unwrapped = unwrapSourceExpression(expression)
  if (unwrapped.type !== 'Identifier') return { expression: unwrapped }
  if (visited.has(unwrapped.name)) {
    throw new SourceAnalysisError(`Circular source binding detected at ${unwrapped.name}.`)
  }
  const bound = bindings.get(unwrapped.name)
  if (!bound) return { expression: unwrapped }
  visited.add(unwrapped.name)
  const resolved = resolveSourceBinding(bound, bindings, visited)
  return {
    expression: resolved.expression,
    bindingName: resolved.bindingName ?? unwrapped.name,
  }
}

function importedFactoryNames(statements: readonly Statement[], factoryName: 'defineTask' | 'experiment') {
  return new Set(
    statements.flatMap((statement) => {
      if (statement.type !== 'ImportDeclaration' || statement.source.value !== '@caemble/core') return []
      return statement.specifiers.flatMap((specifier) => {
        if (specifier.type !== 'ImportSpecifier') return []
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        return imported === factoryName ? [specifier.local.name] : []
      })
    }),
  )
}

function assertStaticImport(statement: Extract<Statement, { type: 'ImportDeclaration' }>, policy: CadSourcePolicy) {
  const source = statement.source.value
  const raw = statement.source.extra?.raw
  if (raw !== JSON.stringify(source) && raw !== `'${source}'`) {
    throw new SourceAnalysisError(`Import specifiers must use plain, unescaped string literals: ${source}`)
  }
  if (source === '@caemble/core') {
    if (
      statement.specifiers.length === 0 ||
      statement.specifiers.some((specifier) => specifier.type !== 'ImportSpecifier')
    ) {
      throw new SourceAnalysisError(
        `${policy[0].toUpperCase()}${policy.slice(1)} modules may only use named or type imports from @caemble/core.`,
      )
    }
    if (
      policy !== 'material' &&
      policy !== 'module' &&
      statement.importKind !== 'type' &&
      statement.specifiers.some((specifier) => {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') return false
        return (
          (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'Material'
        )
      })
    ) {
      throw new SourceAnalysisError('Material instances must be defined in material.tsx and imported from there.')
    }
    return
  }
  if (source.startsWith('./') || source.startsWith('../')) return
  throw new SourceAnalysisError(`Caemble sources may only import @caemble/core or bundle-relative modules: ${source}`)
}

function assertStaticReExport(
  statement: Extract<Statement, { type: 'ExportAllDeclaration' | 'ExportNamedDeclaration' }>,
) {
  const source = statement.source?.value
  if (source === undefined) return
  const raw = statement.source?.extra?.raw
  if (raw !== JSON.stringify(source) && raw !== `'${source}'`) {
    throw new SourceAnalysisError(`Export specifiers must use plain, unescaped string literals: ${source}`)
  }
  if (source === '@caemble/core' || source.startsWith('./') || source.startsWith('../')) return
  throw new SourceAnalysisError(
    `Caemble sources may only re-export @caemble/core or bundle-relative modules: ${source}`,
  )
}

function assertImportPolicy(ast: File, policy: CadSourcePolicy) {
  ast.program.body.forEach((statement) => {
    if (statement.type === 'TSImportEqualsDeclaration' || statement.type === 'TSExportAssignment') {
      throw new SourceAnalysisError('TypeScript import-equals and export-assignment syntax is not supported.')
    }
    if (statement.type === 'ImportDeclaration') {
      assertStaticImport(statement, policy)
      return
    }
    if (
      (statement.type === 'ExportAllDeclaration' || statement.type === 'ExportNamedDeclaration') &&
      statement.source
    ) {
      assertStaticReExport(statement)
    }
  })

  const blockedRuntimeGlobals = new Set([
    'BroadcastChannel',
    'Date',
    'EventSource',
    'Function',
    'MessageChannel',
    'MessageEvent',
    'MessagePort',
    'RTCDataChannel',
    'RTCPeerConnection',
    'SharedWorker',
    'WebSocket',
    'WebSocketStream',
    'WebTransport',
    'Worker',
    'XMLHttpRequest',
    'addEventListener',
    'caches',
    'clearInterval',
    'clearTimeout',
    'close',
    'cookieStore',
    'crypto',
    'dispatchEvent',
    'eval',
    'fetch',
    'global',
    'globalThis',
    'importScripts',
    'indexedDB',
    'location',
    'navigator',
    'onmessage',
    'onmessageerror',
    'performance',
    'postMessage',
    'process',
    'queueMicrotask',
    'removeEventListener',
    'require',
    'self',
    'setInterval',
    'setTimeout',
    'window',
  ])
  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type === 'Import') {
        throw new SourceAnalysisError('Dynamic import is not supported in Caemble CAD sources.')
      }
      if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'require') {
        throw new SourceAnalysisError('Source-level require() is not supported in Caemble CAD sources.')
      }
    },
    ImportExpression() {
      throw new SourceAnalysisError('Dynamic import is not supported in Caemble CAD sources.')
    },
    'MemberExpression|OptionalMemberExpression'(path) {
      const node = path.node as t.MemberExpression | t.OptionalMemberExpression
      let memberName: unknown = null
      if (!node.computed && node.property.type === 'Identifier') memberName = node.property.name
      else if (node.property.type === 'StringLiteral' || node.property.type === 'NumericLiteral') {
        memberName = node.property.value
      } else if (node.computed && node.property.type !== 'PrivateName') {
        const evaluated = (path.get('property') as NodePath<t.Expression>).evaluate()
        if (evaluated.confident) memberName = evaluated.value
      }
      if (['__proto__', 'constructor', 'prototype'].includes(String(memberName))) {
        throw new SourceAnalysisError(`Prototype access is not supported in Caemble sources: ${String(memberName)}.`)
      }
      if (node.object.type !== 'Identifier' || node.object.name !== 'Math' || path.scope.getBinding('Math')) return
      if (memberName === 'random') {
        throw new SourceAnalysisError('Hidden nondeterminism is not supported in Caemble sources: Math.random.')
      }
      if (memberName === null) {
        throw new SourceAnalysisError('Computed Math members must use a fixed deterministic property name.')
      }
    },
    ReferencedIdentifier(path) {
      const name = path.node.name
      if (path.findParent((parent) => parent.isTSType())) return
      if (path.scope.getBinding(name)) return
      if (name === 'Math') {
        const parent = path.parentPath
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node) {
          return
        }
        throw new SourceAnalysisError(
          'Aliasing Math is not supported in Caemble sources; call deterministic Math members directly.',
        )
      }
      if (blockedRuntimeGlobals.has(name)) {
        throw new SourceAnalysisError(`Global runtime access is not supported in Caemble sources: ${name}.`)
      }
    },
  })
}

export function parseCadSource(source: string, policy: CadSourcePolicy = 'experiment', path = 'source.tsx') {
  let ast: File
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    })
  } catch (error) {
    throw new SourceAnalysisError(error instanceof Error ? error.message : 'The CAD source could not be parsed.')
  }
  assertImportPolicy(ast, policy)
  return ast
}

export function staticCadSourceImports(source: string, policy: CadSourcePolicy = 'experiment') {
  const ast = parseCadSource(source, policy)
  return ast.program.body.flatMap((statement) => {
    if (
      statement.type !== 'ImportDeclaration' &&
      statement.type !== 'ExportAllDeclaration' &&
      statement.type !== 'ExportNamedDeclaration'
    )
      return []
    return statement.source ? [statement.source.value] : []
  })
}

function runtimeStaticImports(ast: File) {
  return ast.program.body.flatMap((statement) => {
    if (statement.type === 'ImportDeclaration') {
      if (
        statement.importKind === 'type' ||
        (statement.specifiers.length > 0 &&
          statement.specifiers.every(
            (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
          ))
      ) {
        return []
      }
      return [statement.source.value]
    }
    if (statement.type === 'ExportAllDeclaration') {
      return statement.exportKind === 'type' ? [] : [statement.source.value]
    }
    if (statement.type !== 'ExportNamedDeclaration' || !statement.source || statement.exportKind === 'type') return []
    if (
      statement.specifiers.length > 0 &&
      statement.specifiers.every((specifier) => specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type')
    ) {
      return []
    }
    return [statement.source.value]
  })
}

export function analyzeBundleModuleSource(source: string, path: string) {
  return Object.freeze({ ast: parseCadSource(source, 'module', path) })
}

export function assertExperimentModuleGraph(files: Readonly<Record<string, string>>) {
  const modules = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.endsWith('.ts') || path.endsWith('.tsx')),
  )
  const dependencies = new Map<string, readonly string[]>()
  Object.entries(modules).forEach(([path, source]) => {
    const policy: CadSourcePolicy =
      path === 'experiment.tsx'
        ? 'experiment'
        : path === 'geometry.tsx'
          ? 'geometry'
          : path === 'material.tsx'
            ? 'material'
            : /^tasks\/[A-Za-z][A-Za-z0-9_-]*\.tsx$/u.test(path)
              ? 'task'
              : 'module'
    const ast = parseCadSource(source, policy, path)
    dependencies.set(
      path,
      Object.freeze(
        runtimeStaticImports(ast)
          .filter((specifier) => specifier !== '@caemble/core')
          .map((specifier) => resolveExperimentModuleSpecifier(modules, path, specifier)),
      ),
    )
  })

  const complete = new Set<string>()
  const visiting = new Set<string>()
  const visit = (path: string, chain: readonly string[]) => {
    if (complete.has(path)) return
    if (visiting.has(path)) {
      throw new SourceAnalysisError(`Experiment module dependency cycle detected: ${[...chain, path].join(' -> ')}`)
    }
    visiting.add(path)
    try {
      dependencies.get(path)?.forEach((dependency) => visit(dependency, [...chain, path]))
      complete.add(path)
    } finally {
      visiting.delete(path)
    }
  }
  ;[...dependencies.keys()].sort().forEach((path) => visit(path, []))
}

function analyzeFactorySource(source: string, factoryName: 'defineTask' | 'experiment'): SourceAnalysis {
  const ast = parseCadSource(source, factoryName === 'defineTask' ? 'task' : 'experiment')

  const statements = ast.program.body
  const factoryNames = importedFactoryNames(statements, factoryName)
  if (factoryNames.size === 0) {
    throw new SourceAnalysisError(`${factoryName} must be a named import from @caemble/core.`)
  }

  const defaultExports = statements.filter((statement) => statement.type === 'ExportDefaultDeclaration')
  if (defaultExports.length !== 1) {
    throw new SourceAnalysisError('Exactly one default export is required.')
  }
  const declaration = defaultExports[0].declaration
  if (
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration' ||
    declaration.type === 'TSDeclareFunction'
  ) {
    throw new SourceAnalysisError(`The default export must resolve to ${factoryName}({...}).`)
  }

  const bindings = collectSourceBindings(statements)
  const factory = resolveSourceBinding(declaration, bindings).expression
  if (
    factory.type !== 'CallExpression' ||
    factory.callee.type !== 'Identifier' ||
    !factoryNames.has(factory.callee.name)
  ) {
    throw new SourceAnalysisError(`The default export must resolve statically to ${factoryName}({...}).`)
  }
  const optionsArgument = factory.arguments[0]
  if (!optionsArgument) throw new SourceAnalysisError(`${factoryName}() requires an options object.`)
  const options = resolveSourceBinding(sourceExpression(optionsArgument, `${factoryName} options`), bindings).expression
  if (options.type !== 'ObjectExpression') {
    throw new SourceAnalysisError(
      `${factoryName} options must be an object literal or a directly connected top-level const object literal.`,
    )
  }
  return { ast, bindings, factoryName, options }
}

export function analyzeCadSource(source: string): SourceAnalysis {
  return analyzeFactorySource(source, 'experiment')
}

export function analyzeTaskSource(source: string): SourceAnalysis {
  return analyzeFactorySource(source, 'defineTask')
}

export function analyzeMaterialSource(source: string): MaterialSourceAnalysis {
  const ast = parseCadSource(source, 'material')
  const exports: string[] = []
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') {
      throw new SourceAnalysisError('material.tsx only supports named Material object or factory exports.')
    }
    if (statement.type === 'ExportAllDeclaration') return
    if (statement.type !== 'ExportNamedDeclaration') return
    if (statement.exportKind === 'type') return
    const declaration = statement.declaration
    if (declaration?.type === 'VariableDeclaration') {
      if (declaration.kind !== 'const') {
        throw new SourceAnalysisError('Exported Material bindings must be const values or synchronous functions.')
      }
      declaration.declarations.forEach((item) => {
        if (item.id.type !== 'Identifier' || !item.init) {
          throw new SourceAnalysisError('Exported Material bindings must use initialized identifier names.')
        }
        exports.push(item.id.name)
      })
    } else if (declaration?.type === 'FunctionDeclaration') {
      if (!declaration.id || declaration.async || declaration.generator) {
        throw new SourceAnalysisError('Exported Material factories must be named synchronous functions.')
      }
      exports.push(declaration.id.name)
    } else if (
      declaration &&
      declaration.type !== 'TSInterfaceDeclaration' &&
      declaration.type !== 'TSTypeAliasDeclaration'
    ) {
      throw new SourceAnalysisError('material.tsx only supports named Material object or factory exports.')
    }
    statement.specifiers.forEach((specifier) => {
      if (specifier.type !== 'ExportSpecifier') {
        throw new SourceAnalysisError('material.tsx only supports named local exports.')
      }
      if (specifier.exportKind === 'type') return
      const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : null
      if (!name) throw new SourceAnalysisError('Material exports must use identifier names.')
      if (name === 'default') {
        throw new SourceAnalysisError('material.tsx only supports named Material object or factory exports.')
      }
      exports.push(name)
    })
  })
  if (new Set(exports).size !== exports.length) {
    throw new SourceAnalysisError('Material export names must be unique.')
  }
  return Object.freeze({ ast, exports: Object.freeze(exports) })
}

export function analyzeGeometrySource(
  source: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): GeometrySourceAnalysis {
  const ast = parseCadSource(source, 'geometry')
  const componentNamePattern = /^[A-Z][A-Za-z0-9_]*$/u
  const imports: {
    exportName: string
    alias: string
    specifier: string
    specifierStart: number
    specifierEnd: number
  }[] = []
  const importedBindings = new Set<string>()
  ast.program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration' || statement.source.value === '@caemble/core') return
    if (statement.importKind === 'type') return
    statement.specifiers.forEach((specifier) => {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return
      const exportName =
        specifier.type === 'ImportSpecifier'
          ? specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value
          : specifier.type === 'ImportDefaultSpecifier'
            ? 'default'
            : '*'
      const alias = specifier.local.name
      importedBindings.add(alias)
      imports.push({
        exportName,
        alias,
        specifier: statement.source.value,
        specifierStart: statement.source.start! + 1,
        specifierEnd: statement.source.end! - 1,
      })
    })
  })
  if (new Set(imports.map((item) => item.alias)).size !== imports.length) {
    throw new SourceAnalysisError('Geometry import aliases must be unique within a module.')
  }

  const bindings = collectSourceBindings(ast.program.body)
  const typeDeclarations = new Map<string, TSTypeAliasDeclaration | TSInterfaceDeclaration>()
  const componentAnnotations = new Map<string, TSType>()
  const functions = new Map(
    ast.program.body.flatMap((statement) => {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      return declaration?.type === 'FunctionDeclaration' && declaration.id
        ? [[declaration.id.name, declaration] as const]
        : []
    }),
  )
  const declarationRanges = new Map<string, Readonly<{ start: number; end: number }>>()
  ast.program.body.forEach((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration') {
      typeDeclarations.set(declaration.id.name, declaration)
    }
    if (
      declaration?.type === 'FunctionDeclaration' &&
      declaration.id &&
      declaration.start !== null &&
      declaration.start !== undefined &&
      declaration.end !== null &&
      declaration.end !== undefined
    ) {
      declarationRanges.set(declaration.id.name, Object.freeze({ start: declaration.start, end: declaration.end }))
    }
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') return
    declaration.declarations.forEach((item) => {
      if (item.id.type !== 'Identifier' || !item.init) return
      const annotation =
        item.id.typeAnnotation?.type === 'TSTypeAnnotation' ? item.id.typeAnnotation.typeAnnotation : null
      if (annotation) componentAnnotations.set(item.id.name, annotation)
      if (statement.type === 'ExportNamedDeclaration') {
        bindings.set(item.id.name, sourceExpression(item.init, item.id.name))
      }
      if (item.start !== null && item.start !== undefined && item.end !== null && item.end !== undefined) {
        declarationRanges.set(item.id.name, Object.freeze({ start: item.start, end: item.end }))
      }
    })
  })

  functions.forEach((component, name) => {
    if (componentNamePattern.test(name)) {
      assertGeometryPropDefaults(name, component, null, typeDeclarations)
    }
  })
  bindings.forEach((binding, name) => {
    if (!componentNamePattern.test(name) || functions.has(name)) return
    const resolved = resolveSourceBinding(binding, bindings).expression
    if (resolved.type === 'ArrowFunctionExpression' || resolved.type === 'FunctionExpression') {
      assertGeometryPropDefaults(name, resolved, componentAnnotations.get(name) ?? null, typeDeclarations)
    }
  })

  const exported: { localName: string; name: string }[] = []
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') {
      throw new SourceAnalysisError('Geometry modules only support named Geometry component exports.')
    }
    if (statement.type === 'ExportAllDeclaration') return
    if (statement.type !== 'ExportNamedDeclaration') return
    if (statement.declaration?.type === 'VariableDeclaration') {
      if (statement.declaration.kind !== 'const') {
        throw new SourceAnalysisError('Exported Geometry bindings must be const functions.')
      }
      statement.declaration.declarations.forEach((item) => {
        if (item.id.type !== 'Identifier') {
          throw new SourceAnalysisError('Exported Geometry bindings must use identifier names.')
        }
        exported.push({ localName: item.id.name, name: item.id.name })
      })
    } else if (statement.declaration?.type === 'FunctionDeclaration') {
      if (!statement.declaration.id) throw new SourceAnalysisError('Exported Geometry functions must be named.')
      exported.push({ localName: statement.declaration.id.name, name: statement.declaration.id.name })
    } else if (statement.declaration) {
      throw new SourceAnalysisError('Geometry modules only export function components.')
    }
    statement.specifiers.forEach((specifier) => {
      if (specifier.type !== 'ExportSpecifier') {
        throw new SourceAnalysisError('Geometry modules only support named local exports.')
      }
      const localName = specifier.local.name
      const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
      if (statement.source) importedBindings.add(localName)
      exported.push({ localName, name })
    })
  })
  if (new Set(exported.map((item) => item.name)).size !== exported.length) {
    throw new SourceAnalysisError('Geometry export names must be unique.')
  }
  if (exported.length === 0 && !options.allowEmpty) {
    throw new SourceAnalysisError('Geometry modules must export at least one named component.')
  }

  const exports = exported.map(({ localName, name }) => {
    if (!componentNamePattern.test(name)) {
      throw new SourceAnalysisError(`Geometry export must be PascalCase: ${name}`)
    }
    if (importedBindings.has(localName)) {
      return Object.freeze({ name, defaultedProps: Object.freeze([]), functionRange: null, renderExpression: null })
    }
    let component: Expression | FunctionDeclaration
    if (functions.has(localName)) component = functions.get(localName)!
    else {
      const bound = bindings.get(localName)
      if (!bound) throw new SourceAnalysisError(`Geometry export is unresolved: ${name}`)
      const resolved = resolveSourceBinding(bound, bindings).expression
      component =
        resolved.type === 'Identifier' && functions.has(resolved.name) ? functions.get(resolved.name)! : resolved
    }
    if (
      component.type !== 'ArrowFunctionExpression' &&
      component.type !== 'FunctionExpression' &&
      component.type !== 'FunctionDeclaration'
    ) {
      throw new SourceAnalysisError(`Geometry export must resolve to a function component: ${name}`)
    }
    let renderExpression: Expression | null = null
    if (component.body.type !== 'BlockStatement') {
      renderExpression = sourceExpression(component.body, `${name} body`)
    } else {
      const topLevelReturns = component.body.body.filter(
        (statement): statement is ReturnStatement => statement.type === 'ReturnStatement',
      )
      if (topLevelReturns.length === 1 && topLevelReturns[0].argument) {
        renderExpression = sourceExpression(topLevelReturns[0].argument, `${name} return value`)
      }
    }
    const firstParameter = component.params[0]
    const parameter = firstParameter?.type === 'AssignmentPattern' ? firstParameter.left : firstParameter
    const defaultedProps =
      parameter?.type === 'ObjectPattern'
        ? parameter.properties.flatMap((property) => {
            if (
              property.type !== 'ObjectProperty' ||
              property.computed ||
              property.value.type !== 'AssignmentPattern'
            ) {
              return []
            }
            const key =
              property.key.type === 'Identifier'
                ? property.key.name
                : property.key.type === 'StringLiteral'
                  ? property.key.value
                  : null
            return key && key !== 'id' ? [key] : []
          })
        : []
    return Object.freeze({
      name,
      defaultedProps: Object.freeze([...new Set(defaultedProps)].sort()),
      functionRange:
        declarationRanges.get(localName) ??
        (component.start === null ||
        component.start === undefined ||
        component.end === null ||
        component.end === undefined
          ? null
          : Object.freeze({ start: component.start, end: component.end })),
      renderExpression,
    })
  })
  return Object.freeze({
    ast,
    exports: Object.freeze(exports),
    imports: Object.freeze(imports.map((item) => Object.freeze(item))),
  })
}

export function geometryExportAtOffset(
  analysis: GeometrySourceAnalysis,
  offset: number,
  selectedExport: string | null = null,
) {
  const matches = analysis.exports.filter(
    (item) => item.functionRange && item.functionRange.start <= offset && offset < item.functionRange.end,
  )
  return matches.find((item) => item.name === selectedExport)?.name ?? matches[0]?.name ?? null
}

function exportedIdentifierName(value: t.Identifier | t.StringLiteral) {
  return value.type === 'Identifier' ? value.name : value.value
}

function isTopLevelDeclaration(path: NodePath) {
  return (
    path.parentPath?.isProgram() ||
    (path.parentPath?.isExportNamedDeclaration() && path.parentPath.parentPath?.isProgram())
  )
}

function assertProjectableTopLevel(ast: File) {
  ast.program.body.forEach((statement) => {
    if (
      statement.type === 'ImportDeclaration' ||
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'VariableDeclaration' ||
      statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration' ||
      statement.type === 'TSDeclareFunction' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSTypeAliasDeclaration' ||
      statement.type === 'TSEnumDeclaration' ||
      statement.type === 'TSModuleDeclaration' ||
      statement.type === 'EmptyStatement'
    ) {
      return
    }
    throw new SourceAnalysisError(
      'Geometry export projection only supports top-level imports and declarations; move executable setup into the selected component or a helper function.',
    )
  })
}

export function projectGeometryExportSource(source: string, exportName: string) {
  const analysis = analyzeGeometrySource(source, { allowEmpty: true })
  if (!analysis.exports.some((item) => item.name === exportName)) {
    throw new SourceAnalysisError(`Geometry export was not found: ${exportName}`)
  }
  assertProjectableTopLevel(analysis.ast)

  let localName: string | null = null
  let selectedDeclaration: t.Node | null = null
  analysis.ast.program.body.forEach((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') return
    if (statement.declaration?.type === 'VariableDeclaration') {
      statement.declaration.declarations.forEach((declaration) => {
        if (declaration.id.type === 'Identifier' && declaration.id.name === exportName) {
          localName = declaration.id.name
          selectedDeclaration = declaration
        }
      })
    } else if (statement.declaration?.type === 'FunctionDeclaration' && statement.declaration.id?.name === exportName) {
      localName = statement.declaration.id.name
      selectedDeclaration = statement.declaration
    }
    statement.specifiers.forEach((specifier) => {
      if (
        specifier.type === 'ExportSpecifier' &&
        specifier.exportKind !== 'type' &&
        exportedIdentifierName(specifier.exported) === exportName
      ) {
        localName = exportedIdentifierName(specifier.local)
      }
    })
  })
  if (!localName) throw new SourceAnalysisError(`Geometry export binding could not be resolved: ${exportName}`)

  const paths: { program?: NodePath<t.Program> } = {}
  const extraDeclarations = new Map<string, NodePath>()
  traverse(analysis.ast, {
    Program(path) {
      paths.program = path
    },
    TSInterfaceDeclaration(path) {
      if (isTopLevelDeclaration(path)) extraDeclarations.set(path.node.id.name, path)
    },
    TSTypeAliasDeclaration(path) {
      if (isTopLevelDeclaration(path)) extraDeclarations.set(path.node.id.name, path)
    },
    TSEnumDeclaration(path) {
      if (isTopLevelDeclaration(path)) extraDeclarations.set(path.node.id.name, path)
    },
    TSModuleDeclaration(path) {
      if (isTopLevelDeclaration(path) && path.node.id.type === 'Identifier') {
        extraDeclarations.set(path.node.id.name, path)
      }
    },
  })
  const programPath = paths.program
  if (!programPath) throw new SourceAnalysisError('Geometry source program could not be traversed.')

  const requiredNodes = new Set<t.Node>()
  const pending: NodePath[] = []
  const addDeclaration = (path: NodePath, binding?: Binding) => {
    if (requiredNodes.has(path.node)) return
    if (binding && (binding.kind === 'let' || binding.kind === 'var' || !binding.constant)) {
      throw new SourceAnalysisError(
        `Geometry export projection cannot preserve mutable top-level binding: ${binding.identifier.name}`,
      )
    }
    requiredNodes.add(path.node)
    pending.push(path)
  }
  const targetBinding = programPath.scope.getBinding(localName)
  if (!targetBinding || targetBinding.scope !== programPath.scope) {
    throw new SourceAnalysisError(`Geometry export must resolve to a top-level binding: ${exportName}`)
  }
  addDeclaration(targetBinding.path, targetBinding)

  const addReference = (path: NodePath<t.Identifier | t.JSXIdentifier>) => {
    if (!path.isReferencedIdentifier()) return
    const binding = path.scope.getBinding(path.node.name)
    if (binding) {
      if (binding.scope === programPath!.scope) addDeclaration(binding.path, binding)
      return
    }
    const declaration = extraDeclarations.get(path.node.name)
    if (declaration) addDeclaration(declaration)
  }
  while (pending.length) {
    pending.shift()!.traverse({
      Identifier: addReference,
      JSXIdentifier: addReference,
    })
  }

  const projectedBody: Statement[] = []
  analysis.ast.program.body.forEach((statement) => {
    if (statement.type === 'ImportDeclaration') {
      const specifiers = statement.specifiers.filter((specifier) => requiredNodes.has(specifier))
      if (!specifiers.length) return
      const imported = t.cloneNode(statement, true)
      imported.specifiers = specifiers.map((specifier) => t.cloneNode(specifier, true))
      projectedBody.push(imported)
      return
    }
    if (statement.type === 'ExportNamedDeclaration') {
      const declaration = statement.declaration
      if (declaration?.type === 'VariableDeclaration') {
        declaration.declarations.forEach((item) => {
          if (!requiredNodes.has(item)) return
          const variable = t.cloneNode(declaration, true)
          variable.declarations = [t.cloneNode(item, true)]
          if (item === selectedDeclaration) {
            const exported = t.cloneNode(statement, true)
            exported.declaration = variable
            exported.specifiers = []
            projectedBody.push(exported)
          } else {
            projectedBody.push(variable)
          }
        })
      } else if (declaration && requiredNodes.has(declaration)) {
        const cloned = t.cloneNode(declaration, true) as Statement
        if (declaration === selectedDeclaration) {
          const exported = t.cloneNode(statement, true)
          exported.declaration = cloned as t.Declaration
          exported.specifiers = []
          projectedBody.push(exported)
        } else {
          projectedBody.push(cloned)
        }
      }
      const specifiers = statement.specifiers.filter(
        (specifier) =>
          specifier.type === 'ExportSpecifier' &&
          specifier.exportKind !== 'type' &&
          exportedIdentifierName(specifier.exported) === exportName,
      )
      if (specifiers.length) {
        const exported = t.cloneNode(statement, true)
        exported.declaration = null
        exported.specifiers = specifiers.map((specifier) => t.cloneNode(specifier, true))
        projectedBody.push(exported)
      }
      return
    }
    if (statement.type === 'VariableDeclaration') {
      const declarations = statement.declarations.filter((item) => requiredNodes.has(item))
      if (!declarations.length) return
      const variable = t.cloneNode(statement, true)
      variable.declarations = declarations.map((item) => t.cloneNode(item, true))
      projectedBody.push(variable)
      return
    }
    if (requiredNodes.has(statement)) projectedBody.push(t.cloneNode(statement, true) as Statement)
  })

  const projectedAst = t.cloneNode(analysis.ast, true)
  projectedAst.program.body = projectedBody
  const result = `${generate(projectedAst, { comments: true }).code.trim()}\n`
  const projected = analyzeGeometrySource(result)
  if (projected.exports.length !== 1 || projected.exports[0]?.name !== exportName) {
    throw new SourceAnalysisError(`Projected Geometry source must export only ${exportName}.`)
  }
  return result
}
