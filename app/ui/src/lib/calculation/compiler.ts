import generateModule from '@babel/generator'
import traverseModule from '@babel/traverse'
import * as t from '@babel/types'
import type { File } from '@babel/types'
import type * as Monaco from 'monaco-editor'
import { loadMonaco } from '@/lib/cad/compiler/monacoRuntime'
import { CALCULATION_MONACO_DECLARATION } from './declarations'
import { CALCULATION_INDEX_GUARD_GLOBAL, CALCULATION_INDEX_POLICY_MESSAGE } from './runtimeGlobals'
import { analyzeCalculationSource, createCalculationSourceDiagnostic } from './sourcePolicy'
import { CalculationExecutionError, type CompiledCalculationSource } from './types'

const compilationCache = new Map<string, Promise<CompiledCalculationSource>>()
const generate = (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule
const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule

async function sourceHash(source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function diagnosticMessage(message: string | { messageText: string; next?: readonly unknown[] }): string {
  if (typeof message === 'string') return message
  const children =
    message.next?.flatMap((child) =>
      child && typeof child === 'object' && 'messageText' in child
        ? [diagnosticMessage(child as { messageText: string; next?: readonly unknown[] })]
        : [],
    ) ?? []
  return [message.messageText, ...children].join('\n')
}

async function javascriptWorker(monaco: typeof Monaco) {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await monaco.typescript.getJavaScriptWorker()
    } catch (error) {
      if (!String(error).includes('JavaScript not registered')) throw error
      lastError = error
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    }
  }
  throw lastError
}

function guardComputedIndexes(source: string, ast: File) {
  let guardIdentifier: t.Identifier | null = null
  traverse(ast, {
    'MemberExpression|OptionalMemberExpression'(path) {
      const node = path.node as t.MemberExpression | t.OptionalMemberExpression
      if (
        !node.computed ||
        node.property.type === 'StringLiteral' ||
        node.property.type === 'NumericLiteral' ||
        !t.isExpression(node.property)
      ) {
        return
      }
      guardIdentifier ??= path.scope.getProgramParent().generateUidIdentifier('calculationIndex')
      const diagnostic = createCalculationSourceDiagnostic(source, CALCULATION_INDEX_POLICY_MESSAGE, node.property)
      node.property = t.callExpression(t.cloneNode(guardIdentifier), [
        t.cloneNode(node.property, true),
        t.valueToNode(diagnostic) as t.Expression,
      ])
    },
  })
  return guardIdentifier
}

async function compileWithMonaco(source: string, hash: string, ast: File): Promise<CompiledCalculationSource> {
  const monaco = await loadMonaco()
  const compilationId = crypto.randomUUID()
  const declaration = monaco.typescript.javascriptDefaults.addExtraLib(
    CALCULATION_MONACO_DECLARATION,
    `file:///caemble-calculation/${hash}/${compilationId}/calculation-env.d.ts`,
  )
  const model = monaco.editor.createModel(
    source,
    'javascript',
    monaco.Uri.parse(`file:///caemble-calculation/${hash}/${compilationId}/calculation.js`),
  )
  try {
    const workerFactory = await javascriptWorker(monaco)
    const worker = await workerFactory(model.uri)
    const [syntactic, semantic] = await Promise.all([
      worker.getSyntacticDiagnostics(model.uri.toString()),
      worker.getSemanticDiagnostics(model.uri.toString()),
    ])
    const errors = [...syntactic, ...semantic].filter((diagnostic) => diagnostic.category === 1)
    if (errors.length > 0) {
      throw new CalculationExecutionError(
        'compile',
        errors.map((diagnostic) => diagnosticMessage(diagnostic.messageText)).join('\n'),
      )
    }
    const computedIndexGuard = guardComputedIndexes(source, ast)
    const importedLocals: t.Identifier[] = []
    const importedValues: t.Expression[] = []
    let calculate: t.FunctionExpression | null = null
    ast.program.body.forEach((statement) => {
      if (statement.type === 'ImportDeclaration') {
        statement.specifiers.forEach((specifier) => {
          if (specifier.type !== 'ImportSpecifier') {
            throw new CalculationExecutionError('policy', "Only named imports from 'mathjs' are supported.")
          }
          const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
          importedLocals.push(t.identifier(specifier.local.name))
          importedValues.push(
            t.memberExpression(
              t.callExpression(t.identifier('require'), [t.stringLiteral('mathjs')]),
              t.identifier(imported),
            ),
          )
        })
        return
      }
      if (statement.type !== 'ExportDefaultDeclaration' || statement.declaration.type !== 'FunctionDeclaration') {
        throw new CalculationExecutionError('policy', 'Calculation must use a default-exported function declaration.')
      }
      const declaration = statement.declaration
      calculate = t.functionExpression(
        declaration.id,
        declaration.params,
        declaration.body,
        declaration.generator,
        declaration.async,
      )
    })
    if (!calculate)
      throw new CalculationExecutionError('policy', 'Calculation must export exactly one default function.')
    if (computedIndexGuard) {
      importedLocals.push(computedIndexGuard)
      importedValues.push(t.identifier(CALCULATION_INDEX_GUARD_GLOBAL))
    }
    const exportedCalculation =
      importedLocals.length === 0
        ? calculate
        : t.callExpression(t.arrowFunctionExpression(importedLocals, calculate), importedValues)
    ast.program.body = [
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            t.memberExpression(t.identifier('module'), t.identifier('exports')),
            t.identifier('default'),
          ),
          exportedCalculation,
        ),
      ),
    ]
    const code = generate(ast, { comments: true, compact: false }).code
    return Object.freeze({
      code: `${code}\n//# sourceURL=caemble-calculation://${hash}/calculation.js`,
      sourceHash: hash,
    })
  } finally {
    model.dispose()
    declaration.dispose()
  }
}

export async function compileCalculationSource(source: string): Promise<CompiledCalculationSource> {
  const ast = analyzeCalculationSource(source)
  const hash = await sourceHash(source)
  let compiled = compilationCache.get(hash)
  if (!compiled) {
    compiled = compileWithMonaco(source, hash, ast).catch((error) => {
      compilationCache.delete(hash)
      throw error
    })
    compilationCache.set(hash, compiled)
    if (compilationCache.size > 32) compilationCache.delete(compilationCache.keys().next().value!)
  }
  return compiled
}
