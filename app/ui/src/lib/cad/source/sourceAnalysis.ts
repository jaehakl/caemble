import { parse } from '@babel/parser'
import type { Expression, File, FunctionDeclaration, ObjectExpression, ReturnStatement, Statement } from '@babel/types'
import { isGeometryCoordinate, type GeometryCoordinate } from './geometrySnapshot'

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

export type GeometrySourceImport = Readonly<{
  coordinate: GeometryCoordinate
  localName: string
}>

export type GeometrySourceAnalysis = Readonly<{
  ast: File
  componentName: string | null
  defaultedProps: readonly string[]
  renderExpression: Expression
  imports: readonly GeometrySourceImport[]
}>

type CadSourcePolicy = 'experiment' | 'geometry'

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
      policy === 'geometry' &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some((specifier) => specifier.type !== 'ImportSpecifier'))
    ) {
      throw new SourceAnalysisError('Geometry modules may only use named or type imports from @caemble/core.')
    }
    return
  }
  if (source === '@caemble/geometries') {
    throw new SourceAnalysisError(
      '@caemble/geometries has been removed; use a PascalCase Geometry root alias directly.',
    )
  }
  if (isGeometryCoordinate(source)) {
    if (policy !== 'geometry') {
      throw new SourceAnalysisError(`Exact Geometry imports are only allowed in Geometry modules: ${source}`)
    }
    if (
      statement.importKind === 'type' ||
      statement.specifiers.length !== 1 ||
      statement.specifiers[0].type !== 'ImportDefaultSpecifier'
    ) {
      throw new SourceAnalysisError(`Geometry coordinate imports must use exactly one default import: ${source}`)
    }
    return
  }
  const message =
    policy === 'geometry'
      ? `Geometry import must be @caemble/core or an exact caemble:geometry coordinate: ${source}`
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

export function rewriteGeometryRootAlias(source: string, previousAlias: string, nextAlias: string) {
  const ast = parseCadSource(source)
  type AstNode = Record<string, unknown> & { type: string; start?: number | null; end?: number | null }
  const isNode = (value: unknown): value is AstNode =>
    Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
  const children = (node: AstNode) =>
    Object.entries(node).flatMap(([key, value]) => {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') return []
      return Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []
    })
  const bindingNames = (value: unknown): string[] => {
    if (!isNode(value)) return []
    if (value.type === 'Identifier') return [String(value.name)]
    if (value.type === 'RestElement' || value.type === 'AssignmentPattern' || value.type === 'TSParameterProperty') {
      return bindingNames(value.argument ?? value.left ?? value.parameter)
    }
    if (value.type === 'ObjectPattern') {
      return ((value.properties as unknown[]) ?? []).flatMap((property) => {
        if (!isNode(property)) return []
        return bindingNames(property.type === 'RestElement' ? property.argument : property.value)
      })
    }
    if (value.type === 'ArrayPattern') {
      return ((value.elements as unknown[]) ?? []).flatMap(bindingNames)
    }
    return []
  }
  const isFunction = (node: AstNode) =>
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'

  const scopeBindings = new WeakMap<object, Set<string>>()
  const addBindings = (scope: AstNode, value: unknown) => {
    const names = bindingNames(value)
    if (names.length === 0) return
    const bindings = scopeBindings.get(scope) ?? new Set<string>()
    names.forEach((name) => bindings.add(name))
    scopeBindings.set(scope, bindings)
  }
  const collectBindings = (node: AstNode, scopes: AstNode[]) => {
    let activeScopes = scopes
    if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'CatchClause') {
      scopeBindings.set(node, scopeBindings.get(node) ?? new Set())
      activeScopes = [...scopes, node]
    }
    const currentScope = activeScopes[activeScopes.length - 1]
    if (node.type === 'ImportDeclaration' && currentScope) {
      ;((node.specifiers as unknown[]) ?? []).forEach((specifier) => {
        if (isNode(specifier)) addBindings(currentScope, specifier.local)
      })
    }
    if (node.type === 'VariableDeclaration' && currentScope) {
      const target =
        node.kind === 'var'
          ? ([...activeScopes].reverse().find((scope) => scope.type === 'Program' || isFunction(scope)) ?? currentScope)
          : currentScope
      ;((node.declarations as unknown[]) ?? []).forEach((declaration) => {
        if (isNode(declaration)) addBindings(target, declaration.id)
      })
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && currentScope) {
      addBindings(currentScope, node.id)
    }
    if (isFunction(node)) {
      scopeBindings.set(node, scopeBindings.get(node) ?? new Set())
      if (node.type === 'FunctionExpression') addBindings(node, node.id)
      ;((node.params as unknown[]) ?? []).forEach((parameter) => addBindings(node, parameter))
      activeScopes = [...activeScopes, node]
    }
    if (node.type === 'CatchClause') addBindings(node, node.param)
    children(node).forEach((child) => collectBindings(child, activeScopes))
  }
  collectBindings(ast.program as unknown as AstNode, [])

  const replacements: { start: number; end: number }[] = []
  const referenceRanges = new Set<string>()
  let references = 0
  const addReference = (start: number | null | undefined, end: number | null | undefined) => {
    const range = `${start}:${end}`
    if (referenceRanges.has(range)) return
    referenceRanges.add(range)
    references += 1
    if (previousAlias === nextAlias || start === null || start === undefined || end === null || end === undefined)
      return
    replacements.push({ start, end })
  }
  const isIdentifierReference = (node: AstNode, parent: AstNode | null, key: string | null) => {
    if (node.type !== 'Identifier' || !parent) return false
    if (parent.type.startsWith('TS') && parent.type !== 'TSAsExpression' && parent.type !== 'TSSatisfiesExpression') {
      return false
    }
    if (
      (parent.type === 'VariableDeclarator' && key === 'id') ||
      (isFunction(parent) && (key === 'id' || key === 'params')) ||
      ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && key === 'id') ||
      parent.type.startsWith('Import') ||
      parent.type === 'ExportSpecifier' ||
      parent.type === 'LabeledStatement' ||
      parent.type === 'BreakStatement' ||
      parent.type === 'ContinueStatement'
    ) {
      return false
    }
    if (
      (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
      key === 'property' &&
      !parent.computed
    ) {
      return false
    }
    if (
      (parent.type === 'ObjectProperty' ||
        parent.type === 'ObjectMethod' ||
        parent.type === 'ClassMethod' ||
        parent.type === 'ClassProperty') &&
      key === 'key' &&
      !parent.computed
    ) {
      return false
    }
    return true
  }
  const visitReferences = (node: AstNode, scopes: AstNode[], parent: AstNode | null, key: string | null) => {
    const activeScopes = scopeBindings.has(node) ? [...scopes, node] : scopes
    const isShadowed = (name: string) => activeScopes.some((scope) => Boolean(scopeBindings.get(scope)?.has(name)))
    const matchesJsxTag =
      node.type === 'JSXIdentifier' &&
      node.name === previousAlias &&
      (parent?.type === 'JSXOpeningElement' || parent?.type === 'JSXClosingElement') &&
      parent.name === node
    const matchesIdentifier = node.name === previousAlias && isIdentifierReference(node, parent, key)
    if ((matchesJsxTag || matchesIdentifier) && !isShadowed(previousAlias)) {
      if (previousAlias !== nextAlias && isShadowed(nextAlias)) {
        throw new SourceAnalysisError(
          `Root alias ${nextAlias}와 충돌하는 지역 binding이 있어 source를 안전하게 변경할 수 없습니다.`,
        )
      }
      addReference(node.start, node.end)
    }
    Object.entries(node).forEach(([childKey, value]) => {
      if (childKey === 'loc' || childKey === 'start' || childKey === 'end' || childKey === 'extra') return
      if (Array.isArray(value)) {
        value.forEach((child) => {
          if (isNode(child)) visitReferences(child, activeScopes, node, childKey)
        })
      } else if (isNode(value)) {
        visitReferences(value, activeScopes, node, childKey)
      }
    })
  }
  visitReferences(ast.program as unknown as AstNode, [], null, null)
  const rewritten = replacements
    .sort((left, right) => right.start - left.start)
    .reduce((current, replacement) => {
      return `${current.slice(0, replacement.start)}${nextAlias}${current.slice(replacement.end)}`
    }, source)
  return { source: rewritten, references }
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
  const ast = parseCadSource(source)

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

export function analyzeGeometrySource(source: string): GeometrySourceAnalysis {
  const ast = parseCadSource(source, 'geometry')
  if (
    ast.program.body.some(
      (statement) => statement.type === 'ExportAllDeclaration' || statement.type === 'ExportNamedDeclaration',
    )
  ) {
    throw new SourceAnalysisError('Geometry modules may only export one default value.')
  }
  const defaultExports = ast.program.body.filter((statement) => statement.type === 'ExportDefaultDeclaration')
  if (defaultExports.length !== 1) throw new SourceAnalysisError('Exactly one default export is required.')
  const declaration = defaultExports[0].declaration
  const bindings = collectSourceBindings(ast.program.body)
  const functions = new Map(
    ast.program.body.flatMap((statement) =>
      statement.type === 'FunctionDeclaration' && statement.id ? [[statement.id.name, statement] as const] : [],
    ),
  )
  let component: Expression | FunctionDeclaration
  let componentName: string | null = null
  if (declaration.type === 'FunctionDeclaration') {
    component = declaration
    componentName = declaration.id?.name ?? null
  } else if (declaration.type === 'ClassDeclaration' || declaration.type === 'TSDeclareFunction') {
    throw new SourceAnalysisError('Geometry default export must resolve to a function component.')
  } else {
    const exported = sourceExpression(declaration, 'Geometry default export')
    componentName = exported.type === 'Identifier' ? exported.name : null
    const resolved = resolveSourceBinding(exported, bindings).expression
    component =
      resolved.type === 'Identifier' && functions.has(resolved.name) ? functions.get(resolved.name)! : resolved
  }
  if (
    component.type !== 'ArrowFunctionExpression' &&
    component.type !== 'FunctionExpression' &&
    component.type !== 'FunctionDeclaration'
  ) {
    throw new SourceAnalysisError('Geometry default export must resolve to a function component.')
  }
  if (!componentName && component.type !== 'ArrowFunctionExpression') componentName = component.id?.name ?? null
  let renderExpression: Expression
  const body = component.body
  if (body.type !== 'BlockStatement') {
    renderExpression = sourceExpression(body, 'Geometry component body')
  } else {
    const returns: ReturnStatement[] = []
    const collectReturns = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach(collectReturns)
        return
      }
      const node = value as Record<string, unknown>
      if (node.type === 'ReturnStatement') {
        returns.push(value as ReturnStatement)
        return
      }
      if (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
      ) {
        return
      }
      Object.entries(node).forEach(([key, child]) => {
        if (key !== 'loc' && key !== 'start' && key !== 'end') collectReturns(child)
      })
    }
    body.body.forEach(collectReturns)
    const topLevelReturns = body.body.filter(
      (statement): statement is ReturnStatement => statement.type === 'ReturnStatement',
    )
    if (
      returns.length !== 1 ||
      topLevelReturns.length !== 1 ||
      returns[0] !== topLevelReturns[0] ||
      !returns[0].argument
    ) {
      throw new SourceAnalysisError(
        'Geometry component must use an expression body or one top-level return expression for automatic composition.',
      )
    }
    renderExpression = sourceExpression(returns[0].argument, 'Geometry component return value')
  }
  const imports = ast.program.body.flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration' || !isGeometryCoordinate(statement.source.value)) return []
    const specifier = statement.specifiers[0]
    return [{ coordinate: statement.source.value, localName: specifier.local.name }]
  })
  if (new Set(imports.map(({ coordinate }) => coordinate)).size !== imports.length) {
    throw new SourceAnalysisError('A Geometry coordinate may only be imported once per module.')
  }
  const firstParameter = component.params[0]
  const parameter = firstParameter?.type === 'AssignmentPattern' ? firstParameter.left : firstParameter
  const defaultedProps =
    parameter?.type === 'ObjectPattern'
      ? parameter.properties.flatMap((property) => {
          if (property.type !== 'ObjectProperty' || property.computed || property.value.type !== 'AssignmentPattern') {
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
    ast,
    componentName,
    defaultedProps: Object.freeze([...new Set(defaultedProps)].sort()),
    renderExpression,
    imports: Object.freeze(imports),
  })
}

export function validateGeometryUsage(usage: string, identifier: string) {
  const ast = parseCadSource(`const __geometryUsage = (${usage.trim()})`, 'geometry')
  const statement = ast.program.body[0]
  const declaration = statement?.type === 'VariableDeclaration' ? statement.declarations[0] : undefined
  const expression = declaration?.init
    ? unwrapSourceExpression(sourceExpression(declaration.init, 'Geometry usage'))
    : null
  if (
    !expression ||
    expression.type !== 'JSXElement' ||
    expression.openingElement.name.type !== 'JSXIdentifier' ||
    expression.openingElement.name.name !== identifier
  ) {
    throw new SourceAnalysisError(`Geometry usage must be one <${identifier} ... /> JSX element.`)
  }
  const hasId = expression.openingElement.attributes.some(
    (attribute) =>
      attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' && attribute.name.name === 'id',
  )
  if (!hasId) throw new SourceAnalysisError('Geometry usage must include an explicit id prop.')
  return usage.trim()
}

export function rewriteGeometryImportCoordinates(
  source: string,
  replacements: Readonly<Partial<Record<GeometryCoordinate, GeometryCoordinate>>>,
) {
  const analysis = analyzeGeometrySource(source)
  const edits = analysis.ast.program.body.flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration' || !isGeometryCoordinate(statement.source.value)) return []
    const replacement = replacements[statement.source.value]
    const start = statement.source.start
    const end = statement.source.end
    if (!replacement || start === null || start === undefined || end === null || end === undefined) return []
    const quote = source[start]
    if (quote !== "'" && quote !== '"') {
      throw new SourceAnalysisError(`Geometry import quote could not be preserved: ${statement.source.value}`)
    }
    return [{ start, end, text: `${quote}${replacement}${quote}` }]
  })
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce((current, edit) => `${current.slice(0, edit.start)}${edit.text}${current.slice(edit.end)}`, source)
}
