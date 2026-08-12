import { parse } from '@babel/parser'
import type { Expression, File, ObjectExpression, Statement } from '@babel/types'

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

function importedFactoryNames(
  statements: readonly Statement[],
  factoryName: 'defineTask' | 'experiment',
) {
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

function assertImportPolicy(ast: File) {
  ast.program.body.forEach((statement) => {
    const source =
      statement.type === 'ImportDeclaration' ||
      statement.type === 'ExportAllDeclaration' ||
      statement.type === 'ExportNamedDeclaration'
        ? statement.source?.value
        : undefined
    if (source === undefined) return
    if (source !== '@caemble/core') {
      throw new SourceAnalysisError(`Import is not allowed in an independent Caemble TSX source: ${source}`)
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
      ['Date', 'Function', 'eval', 'fetch', 'queueMicrotask', 'setInterval', 'setTimeout'].includes(
        (node.callee as { name: string }).name,
      )
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
      if (
        object.type === 'Identifier' &&
        ['Date', 'crypto', 'performance'].includes(object.name ?? '')
      ) {
        throw new SourceAnalysisError(`Hidden nondeterminism is not supported in Caemble sources: ${object.name}.`)
      }
    }
    if (
      node.type === 'Identifier' &&
      ['Date', 'crypto', 'globalThis', 'performance', 'process', 'self', 'window'].includes(String(node.name))
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
      throw new SourceAnalysisError('Aliasing Math is not supported in Caemble sources; call deterministic Math members directly.')
    }
    Object.entries(node).forEach(([key, child]) => {
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child)
    })
  }
  visit(ast.program)
}

export function parseCadSource(source: string) {
  let ast: File
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  } catch (error) {
    throw new SourceAnalysisError(error instanceof Error ? error.message : 'The CAD source could not be parsed.')
  }
  assertImportPolicy(ast)
  return ast
}

export function staticCadSourceImports(source: string) {
  const ast = parseCadSource(source)
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
