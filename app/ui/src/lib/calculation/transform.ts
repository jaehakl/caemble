import generateModule from '@babel/generator'
import traverseModule from '@babel/traverse'
import * as t from '@babel/types'
import type { File } from '@babel/types'
import { CALCULATION_INDEX_GUARD_GLOBAL, CALCULATION_INDEX_POLICY_MESSAGE } from './runtimeGlobals'
import { createCalculationSourceDiagnostic } from './sourcePolicy'
import { CalculationExecutionError, type CompiledCalculationSource } from './types'

const generate = (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule
const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule

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

export function transformCalculationSource(source: string, hash: string, ast: File): CompiledCalculationSource {
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
  if (!calculate) throw new CalculationExecutionError('policy', 'Calculation must export exactly one default function.')
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
}
