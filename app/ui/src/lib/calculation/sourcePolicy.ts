import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { File } from '@babel/types'
import { CALCULATION_MATHJS_NAMES } from './mathjsManifest'
import { CALCULATION_SHADOWED_GLOBAL_NAMES } from './runtimeGlobals'
import { CalculationExecutionError, type CalculationSourceDiagnostic } from './types'

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
const allowedMathJsNames = new Set<string>(CALCULATION_MATHJS_NAMES)
const allowedRuntimeGlobals = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TextDecoder',
  'TextEncoder',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakSet',
  'arguments',
  'atob',
  'btoa',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'structuredClone',
  'undefined',
])
const blockedMemberNames = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  '_typedFunctionData',
  'captureStackTrace',
  'constructor',
  'fromJSON',
  'localeCompare',
  'prepareStackTrace',
  'prototype',
  'signatures',
  'stack',
  'stackTraceLimit',
  'toLocaleDateString',
  'toLocaleString',
  'toLocaleTimeString',
])
const blockedGlobals = new Set([
  ...CALCULATION_SHADOWED_GLOBAL_NAMES.filter((name) => name !== 'console'),
  'document',
  'eval',
  'exports',
  'localStorage',
  'module',
  'require',
  'sessionStorage',
])

export function createCalculationSourceDiagnostic(
  source: string,
  message: string,
  node?: t.Node | null,
): CalculationSourceDiagnostic {
  const sourceLines = source.split(/\r?\n/u)
  const startLineNumber = node?.loc?.start.line ?? Math.max(1, sourceLines.length)
  const sourceLine = sourceLines[startLineNumber - 1] ?? ''
  const startColumn = (node?.loc?.start.column ?? sourceLine.length) + 1
  const endColumn =
    node?.loc?.end.line === startLineNumber
      ? Math.max(startColumn, node.loc.end.column + 1)
      : Math.max(startColumn, sourceLine.length + 1)
  return {
    message,
    range: { startLineNumber, startColumn, endLineNumber: startLineNumber, endColumn },
    sourceLine,
  }
}

function policyError(source: string, message: string, node?: t.Node | null): never {
  throw new CalculationExecutionError('policy', message, createCalculationSourceDiagnostic(source, message, node))
}

function resolvesToGlobalAlias(path: NodePath<t.Expression>, globalName: 'console' | 'Math'): boolean {
  if (path.node.type !== 'Identifier') return false
  const binding = path.scope.getBinding(path.node.name)
  if (!binding) return path.node.name === globalName
  if (!binding.constant || !binding.path.isVariableDeclarator()) return false
  const initializer = binding.path.get('init')
  return initializer.isIdentifier() && resolvesToGlobalAlias(initializer, globalName)
}

export function analyzeCalculationSource(source: string): File {
  let ast: File
  try {
    ast = parse(source, { sourceType: 'module' })
  } catch (error) {
    throw new CalculationExecutionError(
      'compile',
      error instanceof Error ? error.message : 'Calculation JavaScript could not be parsed.',
    )
  }
  let defaultExportCount = 0
  ast.program.body.forEach((statement) => {
    if (statement.type === 'ImportDeclaration') {
      if (statement.source.value !== 'mathjs')
        policyError(source, `Calculation imports are limited to 'mathjs'.`, statement.source)
      if (statement.importKind === 'type')
        policyError(source, "Calculation runtime imports must use named values from 'mathjs'.", statement)
      statement.specifiers.forEach((specifier) => {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') {
          policyError(source, "Only named imports from 'mathjs' are supported.", specifier)
        }
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        if (!allowedMathJsNames.has(imported))
          policyError(source, `Math.js API is not available in Calculation v1: ${imported}`, specifier.imported)
      })
      return
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      defaultExportCount += 1
      if (statement.declaration.type !== 'FunctionDeclaration') {
        policyError(source, 'Calculation must use a default-exported function declaration.', statement.declaration)
      }
      if (statement.declaration.async || statement.declaration.generator) {
        policyError(source, 'Calculation default export must be a synchronous function.', statement.declaration)
      }
      if (statement.declaration.params.length !== 1 || statement.declaration.params[0].type !== 'Identifier') {
        policyError(
          source,
          'Calculation default export must accept exactly one input parameter.',
          statement.declaration.params[1] ?? statement.declaration.params[0] ?? statement.declaration,
        )
      }
      return
    }
    if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') {
      policyError(source, 'Calculation can export only one default function.', statement)
    }
    policyError(source, 'Calculation module can contain only Math.js imports and one default function.', statement)
  })
  if (defaultExportCount !== 1) policyError(source, 'Calculation must export exactly one default function.')

  traverse(ast, {
    AwaitExpression(path) {
      policyError(source, 'Calculation source must be synchronous; await is not supported.', path.node)
    },
    CallExpression(path) {
      if (path.node.callee.type === 'Import')
        policyError(source, 'Dynamic import is not supported in Calculation source.', path.node.callee)
    },
    ImportExpression(path) {
      policyError(source, 'Dynamic import is not supported in Calculation source.', path.node)
    },
    'MemberExpression|OptionalMemberExpression'(path) {
      const node = path.node as t.MemberExpression | t.OptionalMemberExpression
      const memberName =
        !node.computed && node.property.type === 'Identifier'
          ? node.property.name
          : node.property.type === 'StringLiteral' || node.property.type === 'NumericLiteral'
            ? String(node.property.value)
            : null
      if (
        node.computed &&
        node.property.type === 'NumericLiteral' &&
        (!Number.isSafeInteger(node.property.value) || node.property.value < 0)
      ) {
        policyError(source, 'Calculation numeric indexes must be non-negative safe integers.', node.property)
      }
      const objectPath = path.get('object')
      if (objectPath.isExpression() && resolvesToGlobalAlias(objectPath, 'console')) {
        if (memberName !== 'log') {
          policyError(source, 'Calculation console exposes only console.log.', node.property)
        }
      }
      if (memberName !== null && blockedMemberNames.has(memberName)) {
        policyError(source, `Prototype access is not supported in Calculation source: ${memberName}.`, node.property)
      }
      if (node.object.type === 'Identifier' && node.object.name === 'Object' && !path.scope.getBinding('Object')) {
        if (
          !memberName ||
          !['entries', 'freeze', 'fromEntries', 'hasOwn', 'is', 'isFrozen', 'keys', 'values'].includes(memberName)
        ) {
          policyError(
            source,
            `Object.${memberName ?? '<computed>'} is not supported in Calculation source.`,
            node.property,
          )
        }
      }
      if (node.object.type === 'Identifier' && node.object.name === 'Array' && !path.scope.getBinding('Array')) {
        if (!memberName || !['from', 'isArray', 'of'].includes(memberName)) {
          policyError(
            source,
            `Array.${memberName ?? '<computed>'} is not supported in Calculation source.`,
            node.property,
          )
        }
      }
      if (!objectPath.isExpression() || !resolvesToGlobalAlias(objectPath, 'Math')) return
      if (memberName === 'random')
        policyError(source, 'Random functions are not supported in Calculation v1.', node.property)
      if (memberName === null)
        policyError(source, 'Computed Math members must use a fixed deterministic property name.', node.property)
    },
    ReferencedIdentifier(path) {
      if (path.findParent((parent) => parent.isTSType())) return
      if (path.scope.getBinding(path.node.name)) return
      if (path.node.name === 'console' || path.node.name === 'Math') return
      if (path.node.name === 'Object' || path.node.name === 'Array') {
        const parent = path.parentPath
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node)
          return
        policyError(source, `Aliasing ${path.node.name} is not supported in Calculation source.`, path.node)
      }
      if (blockedGlobals.has(path.node.name)) {
        policyError(
          source,
          `Global runtime access is not supported in Calculation source: ${path.node.name}.`,
          path.node,
        )
      }
      if (!allowedRuntimeGlobals.has(path.node.name)) {
        policyError(source, `Calculation source references an unsupported global: ${path.node.name}.`, path.node)
      }
    },
    ObjectProperty(path) {
      const key = path.node.key
      if (path.node.computed && key.type !== 'StringLiteral' && key.type !== 'NumericLiteral') {
        policyError(source, 'Computed Calculation properties must use a fixed string or numeric property.', key)
      }
      const name = key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null
      if (name !== null && blockedMemberNames.has(name)) {
        policyError(source, `Prototype property access is not supported in Calculation source: ${name}.`, key)
      }
    },
    ObjectMethod(path) {
      if (path.node.computed && path.node.key.type !== 'StringLiteral' && path.node.key.type !== 'NumericLiteral') {
        policyError(source, 'Computed Calculation methods must use a fixed string or numeric property.', path.node.key)
      }
    },
  })
  return ast
}
