import generate from '@babel/generator'
import { parse } from '@babel/parser'
import traverse, { type Binding, type NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import type { Expression, File, FunctionDeclaration, ObjectExpression, ReturnStatement, Statement } from '@babel/types'

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
    coordinate: string
    specifierStart: number
    specifierEnd: number
  }>[]
}>

export type MaterialSourceAnalysis = Readonly<{
  ast: File
  exports: readonly string[]
}>

type CadSourcePolicy = 'experiment' | 'task' | 'geometry' | 'material'

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
  if (policy === 'geometry' && /^caemble:geometry\/.+@(?:local|\d+\.\d+\.\d+)$/u.test(source)) {
    if (
      statement.specifiers.length === 0 ||
      statement.specifiers.some((specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type')
    ) {
      throw new SourceAnalysisError('Geometry dependencies must use named runtime imports.')
    }
    return
  }
  const relativeModule =
    (policy === 'experiment' && source === './geometry') || (policy === 'task' && source === '../geometry')
      ? 'geometry.tsx'
      : (policy === 'experiment' && source === './material') || (policy === 'task' && source === '../material')
        ? 'material.tsx'
        : null
  if (relativeModule !== null) {
    if (statement.specifiers.length === 0 || statement.specifiers.some((item) => item.type !== 'ImportSpecifier')) {
      throw new SourceAnalysisError(`${relativeModule} must be used through named imports.`)
    }
    return
  }
  const message =
    policy === 'geometry'
      ? `Geometry modules may only import @caemble/core or named Geometry coordinates: ${source}`
      : policy === 'material'
        ? `Material modules may only import @caemble/core: ${source}`
        : `Import is not allowed in an independent Caemble TSX source: ${source}`
  throw new SourceAnalysisError(message)
}

function assertImportPolicy(ast: File, policy: CadSourcePolicy) {
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ImportDeclaration') {
      assertStaticImport(statement, policy)
      return
    }
    if (
      (statement.type === 'ExportAllDeclaration' || statement.type === 'ExportNamedDeclaration') &&
      statement.source
    ) {
      throw new SourceAnalysisError(`Re-export is not supported in Caemble sources: ${statement.source.value}`)
    }
  })

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as Record<string, unknown>
    if (
      node.type === 'ImportExpression' ||
      (node.type === 'CallExpression' && (node.callee as { type?: string })?.type === 'Import')
    ) {
      throw new SourceAnalysisError('Dynamic import is not supported in Caemble CAD sources.')
    }
    if (
      node.type === 'CallExpression' &&
      (node.callee as { name?: string; type?: string })?.type === 'Identifier' &&
      (node.callee as { name?: string }).name === 'require'
    ) {
      throw new SourceAnalysisError('Source-level require() is not supported in Caemble CAD sources.')
    }
    if (
      (node.type === 'CallExpression' || node.type === 'NewExpression') &&
      (node.callee as { type?: string; name?: string })?.type === 'Identifier' &&
      [
        'Date',
        'Function',
        'SharedWorker',
        'WebSocket',
        'Worker',
        'XMLHttpRequest',
        'clearInterval',
        'clearTimeout',
        'eval',
        'fetch',
        'queueMicrotask',
        'setInterval',
        'setTimeout',
      ].includes((node.callee as { name: string }).name)
    ) {
      throw new SourceAnalysisError(
        `Hidden nondeterminism is not supported in Caemble sources: ${(node.callee as { name: string }).name}.`,
      )
    }
    if (node.type === 'MemberExpression') {
      const object = node.object as { type?: string; name?: string }
      const property = node.property as { type?: string; name?: string; value?: unknown }
      const propertyName = property.type === 'Identifier' ? property.name : property.value
      if (['__proto__', 'constructor', 'prototype'].includes(String(propertyName))) {
        throw new SourceAnalysisError(`Prototype access is not supported in Caemble sources: ${String(propertyName)}.`)
      }
      if (object.type === 'Identifier' && object.name === 'Math' && propertyName === 'random') {
        throw new SourceAnalysisError('Hidden nondeterminism is not supported in Caemble sources: Math.random.')
      }
      if (object.type === 'Identifier' && ['Date', 'crypto', 'performance'].includes(object.name ?? '')) {
        throw new SourceAnalysisError(`Hidden nondeterminism is not supported in Caemble sources: ${object.name}.`)
      }
    }
    if (
      node.type === 'Identifier' &&
      [
        'Date',
        'SharedWorker',
        'WebSocket',
        'Worker',
        'XMLHttpRequest',
        'crypto',
        'global',
        'globalThis',
        'performance',
        'process',
        'self',
        'window',
      ].includes(String(node.name))
    ) {
      throw new SourceAnalysisError(`Global runtime access is not supported in Caemble sources: ${node.name}.`)
    }
    if (
      node.type === 'VariableDeclarator' &&
      (node.id as { type?: string }).type !== 'Identifier' &&
      (node.init as { type?: string; name?: string } | null)?.type === 'Identifier' &&
      ['Math', 'Date', 'crypto', 'performance'].includes((node.init as { name: string }).name)
    ) {
      throw new SourceAnalysisError('Destructuring runtime globals is not supported in Caemble sources.')
    }
    if (
      node.type === 'VariableDeclarator' &&
      (node.init as { type?: string; name?: string } | null)?.type === 'Identifier' &&
      (node.init as { name: string }).name === 'Math'
    ) {
      throw new SourceAnalysisError(
        'Aliasing Math is not supported in Caemble sources; call deterministic Math members directly.',
      )
    }
    Object.entries(node).forEach(([key, child]) => {
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child)
    })
  }
  visit(ast.program)
}

export function parseCadSource(source: string, policy: CadSourcePolicy = 'experiment') {
  let ast: File
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
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
  const importedBindings = new Set(
    ast.program.body.flatMap((statement) =>
      statement.type === 'ImportDeclaration' ? statement.specifiers.map((specifier) => specifier.local.name) : [],
    ),
  )
  const exports: string[] = []
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration') {
      throw new SourceAnalysisError('material.tsx only supports named Material object or factory exports.')
    }
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
      const localName = specifier.local.name
      const name = specifier.exported.type === 'Identifier' ? specifier.exported.name : null
      if (!name) throw new SourceAnalysisError('Material exports must use identifier names.')
      if (name === 'default') {
        throw new SourceAnalysisError('material.tsx only supports named Material object or factory exports.')
      }
      if (importedBindings.has(localName)) {
        throw new SourceAnalysisError('Material exports must be defined locally in material.tsx.')
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
  options: Readonly<{ allowEmpty?: boolean; allowLocal?: boolean }> = {},
): GeometrySourceAnalysis {
  const ast = parseCadSource(source, 'geometry')
  const coordinatePattern =
    /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@(local|\d+\.\d+\.\d+)$/u
  const componentNamePattern = /^[A-Z][A-Za-z0-9_]*$/u
  const imports: {
    exportName: string
    alias: string
    coordinate: string
    specifierStart: number
    specifierEnd: number
  }[] = []
  const importedBindings = new Set<string>()
  ast.program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration' || statement.source.value === '@caemble/core') return
    const match = coordinatePattern.exec(statement.source.value)
    if (!match || (match[1] === 'local' && !options.allowLocal)) {
      throw new SourceAnalysisError(`Geometry import must use an exact coordinate: ${statement.source.value}`)
    }
    statement.specifiers.forEach((specifier) => {
      if (specifier.type !== 'ImportSpecifier') {
        throw new SourceAnalysisError('Geometry dependencies must use named imports.')
      }
      const exportName = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      const alias = specifier.local.name
      if (!componentNamePattern.test(exportName) || !componentNamePattern.test(alias)) {
        throw new SourceAnalysisError('Geometry export names and aliases must be PascalCase identifiers.')
      }
      importedBindings.add(alias)
      imports.push({
        exportName,
        alias,
        coordinate: statement.source.value,
        specifierStart: statement.source.start! + 1,
        specifierEnd: statement.source.end! - 1,
      })
    })
  })
  if (new Set(imports.map((item) => item.alias)).size !== imports.length) {
    throw new SourceAnalysisError('Geometry import aliases must be unique within a module.')
  }

  const bindings = collectSourceBindings(ast.program.body)
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
      if (statement.type === 'ExportNamedDeclaration') {
        bindings.set(item.id.name, sourceExpression(item.init, item.id.name))
      }
      if (item.start !== null && item.start !== undefined && item.end !== null && item.end !== undefined) {
        declarationRanges.set(item.id.name, Object.freeze({ start: item.start, end: item.end }))
      }
    })
  })

  const exported: { localName: string; name: string }[] = []
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration') {
      throw new SourceAnalysisError('Geometry modules only support named Geometry component exports.')
    }
    if (statement.type !== 'ExportNamedDeclaration') return
    if (statement.source) throw new SourceAnalysisError('Geometry re-exports must use an imported local binding.')
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
      exported.push({ localName, name })
    })
  })
  if (new Set(exported.map((item) => item.name)).size !== exported.length) {
    throw new SourceAnalysisError('Geometry export names must be unique.')
  }
  if (exported.length === 0 && !options.allowEmpty) {
    throw new SourceAnalysisError('Published Geometry modules must export at least one named component.')
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
  const analysis = analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true })
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
  const projected = analyzeGeometrySource(result, { allowLocal: true })
  if (projected.exports.length !== 1 || projected.exports[0]?.name !== exportName) {
    throw new SourceAnalysisError(`Projected Geometry source must export only ${exportName}.`)
  }
  const localImport = projected.imports.find((item) => item.coordinate.endsWith('@local'))
  if (localImport) {
    throw new SourceAnalysisError(
      `Publish local Geometry dependency first, then retry with an exact import: ${localImport.coordinate}`,
    )
  }
  return result
}
