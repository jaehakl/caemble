import traverseModule, { type NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import { analyzeCalculationSource, createCalculationSourceDiagnostic } from './sourcePolicy'
import { CalculationExecutionError } from './types'

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule

export function calculationInputBindingName(source: string): string {
  const ast = analyzeCalculationSource(source)
  for (const statement of ast.program.body) {
    if (statement.type !== 'ExportDefaultDeclaration' || statement.declaration.type !== 'FunctionDeclaration') continue
    const parameter = statement.declaration.params[0]
    if (parameter?.type === 'Identifier') return parameter.name
  }
  throw new CalculationExecutionError('policy', 'Calculation input binding could not be resolved.')
}

export function calculationExperimentRecordReference(source: string, recordName: string): string {
  return `${calculationInputBindingName(source)}[${JSON.stringify(recordName)}]`
}

function dependencyError(source: string, message: string, node: t.Node): never {
  throw new CalculationExecutionError('policy', message, createCalculationSourceDiagnostic(source, message, node))
}

function fixedPropertyName(node: t.MemberExpression | t.OptionalMemberExpression) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'StringLiteral') return node.property.value
  return null
}

export function analyzeCalculationDependencies(source: string, availableNames: readonly string[]): readonly string[] {
  const ast = analyzeCalculationSource(source)
  const dependencies = new Set<string>()
  const available = new Set(availableNames)
  let inputBinding: ReturnType<NodePath['scope']['getBinding']> | undefined

  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const declaration = path.get('declaration')
      if (!declaration.isFunctionDeclaration()) return
      const parameter = declaration.get('params')[0]
      if (!parameter?.isIdentifier()) return
      inputBinding = declaration.scope.getBinding(parameter.node.name)
    },
  })
  if (!inputBinding) throw new CalculationExecutionError('policy', 'Calculation input binding could not be resolved.')

  const resolvesToInput = (path: NodePath<t.Identifier>, seen = new Set<unknown>()): boolean => {
    const binding = path.scope.getBinding(path.node.name)
    if (!binding || seen.has(binding)) return false
    if (binding === inputBinding) return true
    seen.add(binding)
    if (!binding.constant || !binding.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier())
      return false
    const initializer = binding.path.get('init')
    return initializer.isIdentifier() && resolvesToInput(initializer, seen)
  }

  const addDependency = (name: string, node: t.Node) => {
    if (!available.has(name)) {
      dependencyError(source, `Calculation references an unknown ExperimentRecord: ${name}`, node)
    }
    dependencies.add(name)
  }

  traverse(ast, {
    ReferencedIdentifier(path) {
      if (!path.isIdentifier()) return
      if (!resolvesToInput(path)) return
      const parent = path.parentPath
      if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node) {
        const name = fixedPropertyName(parent.node)
        if (name === null) {
          dependencyError(source, 'Calculation input keys must be fixed ExperimentRecord names.', parent.node.property)
        }
        addDependency(name, parent.node.property)
        return
      }
      if (parent.isVariableDeclarator() && parent.node.init === path.node) {
        const target = parent.get('id')
        if (target.isIdentifier()) {
          const aliasBinding = target.scope.getBinding(target.node.name)
          if (!aliasBinding?.constant || !parent.parentPath.isVariableDeclaration({ kind: 'const' })) {
            dependencyError(source, 'Calculation input aliases must be immutable const bindings.', target.node)
          }
          return
        }
        if (target.isObjectPattern()) {
          target.get('properties').forEach((property) => {
            if (property.isRestElement()) {
              dependencyError(source, 'Calculation input rest destructuring is not supported.', property.node)
            }
            if (!property.isObjectProperty()) return
            const key = property.node.key
            const name =
              !property.node.computed && key.type === 'Identifier'
                ? key.name
                : key.type === 'StringLiteral'
                  ? key.value
                  : null
            if (name === null) {
              dependencyError(source, 'Calculation input destructuring keys must be fixed strings.', key)
            }
            addDependency(name, key)
          })
          return
        }
      }
      dependencyError(
        source,
        'Calculation input must be accessed through fixed keys; enumeration, spread, escape, and reassignment are not supported.',
        path.node,
      )
    },
  })

  return Object.freeze([...dependencies].sort())
}
