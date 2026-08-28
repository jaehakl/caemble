import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import type * as t from '@babel/types'
import type { File } from '@babel/types'
import { CALCULATION_MATHJS_NAMES } from './mathjsManifest'
import { CALCULATION_SHADOWED_GLOBAL_NAMES } from './runtimeGlobals'
import { CalculationExecutionError } from './types'

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

function policyError(message: string): never {
  throw new CalculationExecutionError('policy', message)
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
      if (statement.source.value !== 'mathjs') policyError(`Calculation imports are limited to 'mathjs'.`)
      if (statement.importKind === 'type')
        policyError("Calculation runtime imports must use named values from 'mathjs'.")
      statement.specifiers.forEach((specifier) => {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') {
          policyError("Only named imports from 'mathjs' are supported.")
        }
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        if (!allowedMathJsNames.has(imported))
          policyError(`Math.js API is not available in Calculation v1: ${imported}`)
      })
      return
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      defaultExportCount += 1
      if (statement.declaration.type !== 'FunctionDeclaration') {
        policyError('Calculation must use a default-exported function declaration.')
      }
      if (statement.declaration.async || statement.declaration.generator) {
        policyError('Calculation default export must be a synchronous function.')
      }
      if (statement.declaration.params.length !== 1 || statement.declaration.params[0].type !== 'Identifier') {
        policyError('Calculation default export must accept exactly one input parameter.')
      }
      return
    }
    if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') {
      policyError('Calculation can export only one default function.')
    }
    policyError('Calculation module can contain only Math.js imports and one default function.')
  })
  if (defaultExportCount !== 1) policyError('Calculation must export exactly one default function.')

  traverse(ast, {
    AwaitExpression() {
      policyError('Calculation source must be synchronous; await is not supported.')
    },
    CallExpression(path) {
      if (path.node.callee.type === 'Import') policyError('Dynamic import is not supported in Calculation source.')
    },
    ImportExpression() {
      policyError('Dynamic import is not supported in Calculation source.')
    },
    'MemberExpression|OptionalMemberExpression'(path) {
      const node = path.node as t.MemberExpression | t.OptionalMemberExpression
      const memberName =
        !node.computed && node.property.type === 'Identifier'
          ? node.property.name
          : node.property.type === 'StringLiteral' || node.property.type === 'NumericLiteral'
            ? String(node.property.value)
            : null
      if (node.computed && memberName === null) {
        policyError('Computed Calculation members must use a fixed string or numeric property.')
      }
      if (node.object.type === 'Identifier' && node.object.name === 'console' && !path.scope.getBinding('console')) {
        if (node.computed || memberName !== 'log') {
          policyError('Calculation source supports only direct console.log(...) calls.')
        }
      }
      if (memberName !== null && blockedMemberNames.has(memberName)) {
        policyError(`Prototype access is not supported in Calculation source: ${memberName}.`)
      }
      if (node.object.type === 'Identifier' && node.object.name === 'Object' && !path.scope.getBinding('Object')) {
        if (
          !memberName ||
          !['entries', 'freeze', 'fromEntries', 'hasOwn', 'is', 'isFrozen', 'keys', 'values'].includes(memberName)
        ) {
          policyError(`Object.${memberName ?? '<computed>'} is not supported in Calculation source.`)
        }
      }
      if (node.object.type === 'Identifier' && node.object.name === 'Array' && !path.scope.getBinding('Array')) {
        if (!memberName || !['from', 'isArray', 'of'].includes(memberName)) {
          policyError(`Array.${memberName ?? '<computed>'} is not supported in Calculation source.`)
        }
      }
      if (node.object.type !== 'Identifier' || node.object.name !== 'Math' || path.scope.getBinding('Math')) return
      if (memberName === 'random') policyError('Random functions are not supported in Calculation v1.')
      if (memberName === null) policyError('Computed Math members must use a fixed deterministic property name.')
    },
    ReferencedIdentifier(path) {
      if (path.findParent((parent) => parent.isTSType())) return
      if (path.scope.getBinding(path.node.name)) return
      if (path.node.name === 'console') {
        const member = path.parentPath
        const call = member.parentPath
        if (
          member.isMemberExpression() &&
          member.node.object === path.node &&
          !member.node.computed &&
          member.node.property.type === 'Identifier' &&
          member.node.property.name === 'log' &&
          call?.isCallExpression() &&
          call.node.callee === member.node
        ) {
          return
        }
        policyError('Calculation source supports only direct console.log(...) calls.')
      }
      if (path.node.name === 'Math') {
        const parent = path.parentPath
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node)
          return
        policyError('Aliasing Math is not supported in Calculation source.')
      }
      if (path.node.name === 'Object' || path.node.name === 'Array') {
        const parent = path.parentPath
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node)
          return
        policyError(`Aliasing ${path.node.name} is not supported in Calculation source.`)
      }
      if (blockedGlobals.has(path.node.name)) {
        policyError(`Global runtime access is not supported in Calculation source: ${path.node.name}.`)
      }
      if (!allowedRuntimeGlobals.has(path.node.name)) {
        policyError(`Calculation source references an unsupported global: ${path.node.name}.`)
      }
    },
    ObjectProperty(path) {
      const key = path.node.key
      if (path.node.computed && key.type !== 'StringLiteral' && key.type !== 'NumericLiteral') {
        policyError('Computed Calculation properties must use a fixed string or numeric property.')
      }
      const name = key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null
      if (name !== null && blockedMemberNames.has(name)) {
        policyError(`Prototype property access is not supported in Calculation source: ${name}.`)
      }
    },
    ObjectMethod(path) {
      if (path.node.computed && path.node.key.type !== 'StringLiteral' && path.node.key.type !== 'NumericLiteral') {
        policyError('Computed Calculation methods must use a fixed string or numeric property.')
      }
    },
  })
  return ast
}
