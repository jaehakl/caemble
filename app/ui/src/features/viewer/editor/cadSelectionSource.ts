import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule

export type CadSourceIdSelection = Readonly<{
  kind: 'geometry' | 'surface'
  match: 'exact' | 'local'
  value: string
}>

export type CadSourcePathLocation = Readonly<{
  column: number
  end: number
  line: number
  path: string
  preview: string
  start: number
}>

type SelectionCandidate = CadSourceIdSelection & Readonly<{ end: number; start: number }>

function literalRange(node: Readonly<{ end?: number | null; start?: number | null }>, padding = 1) {
  if (node.start === null || node.start === undefined || node.end === null || node.end === undefined) return null
  return { start: node.start + padding, end: node.end - padding }
}

function candidate(value: string, range: Readonly<{ end: number; start: number }>, match: 'exact' | 'local') {
  return {
    ...range,
    kind: value.match(/\/surface\/(?:0|[1-9]\d*)$/u) ? ('surface' as const) : ('geometry' as const),
    match,
    value,
  }
}

export function findCadSourcePathLocationsByValue(
  files: Readonly<Record<string, string>>,
  values: readonly string[],
): ReadonlyMap<string, readonly CadSourcePathLocation[]> {
  const requestedValues = new Set(values)
  const locationsByValue = new Map<string, CadSourcePathLocation[]>()
  requestedValues.forEach((value) => locationsByValue.set(value, []))
  if (requestedValues.size === 0) return locationsByValue

  Object.keys(files)
    .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
    .sort()
    .forEach((path) => {
      const source = files[path]
      let ast
      try {
        ast = parse(source, {
          sourceType: 'module',
          plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
        })
      } catch {
        return
      }
      const addLocation = (node: Readonly<{ end?: number | null; start?: number | null }>, literalValue: string) => {
        const locations = locationsByValue.get(literalValue)
        if (!locations) return
        const range = literalRange(node)
        if (!range) return
        const lineStart = source.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
        const lineEnd = source.indexOf('\n', range.end)
        locations.push({
          column: range.start - lineStart + 1,
          end: range.end,
          line: source.slice(0, lineStart).split('\n').length,
          path,
          preview: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim(),
          start: range.start,
        })
      }
      traverse(ast, {
        StringLiteral(stringPath) {
          addLocation(stringPath.node, stringPath.node.value)
        },
        TemplateLiteral(templatePath) {
          if (templatePath.node.expressions.length === 0) {
            addLocation(templatePath.node, templatePath.node.quasis[0]?.value.cooked ?? '')
          }
        },
      })
    })
  locationsByValue.forEach((locations) =>
    locations.sort((left, right) => left.path.localeCompare(right.path) || left.start - right.start),
  )
  return locationsByValue
}

export function findCadSourcePathLocations(
  files: Readonly<Record<string, string>>,
  value: string,
): CadSourcePathLocation[] {
  return [...(findCadSourcePathLocationsByValue(files, [value]).get(value) ?? [])]
}

export function cadSourceIdSelectionAtRange(
  source: string,
  path: string,
  selection: Readonly<{ end: number; start: number }>,
): CadSourceIdSelection | null {
  let ast
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    })
  } catch {
    return null
  }

  const candidates: SelectionCandidate[] = []
  traverse(ast, {
    JSXAttribute(attributePath) {
      if (attributePath.node.name.type !== 'JSXIdentifier' || attributePath.node.name.name !== 'id') return
      const attributeValue = attributePath.node.value
      if (!attributeValue) return
      if (attributeValue.type === 'StringLiteral') {
        const range = literalRange(attributeValue)
        if (range) candidates.push(candidate(attributeValue.value, range, 'local'))
        return
      }
      if (attributeValue.type !== 'JSXExpressionContainer') return
      const expression = attributeValue.expression
      if (expression.type === 'StringLiteral') {
        const range = literalRange(expression)
        if (range) candidates.push(candidate(expression.value, range, 'local'))
      } else if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
        const range = literalRange(expression)
        if (range) candidates.push(candidate(expression.quasis[0]?.value.cooked ?? '', range, 'local'))
      }
    },
    StringLiteral(stringPath) {
      const idAttribute = stringPath.findParent(
        (parent) =>
          parent.isJSXAttribute() && parent.node.name.type === 'JSXIdentifier' && parent.node.name.name === 'id',
      )
      if (idAttribute) return
      const groupProperty = stringPath.findParent((parent) => {
        if (!parent.isObjectProperty() || parent.node.computed) return false
        const key = parent.node.key
        const name = key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null
        return name === 'geometryGroup' || name === 'surfaceGroup'
      })
      const value = stringPath.node.value.trim()
      const looksLikeGlobalPath =
        /^.+\/surface\/(?:0|[1-9]\d*)$/u.test(value) || /^[\p{L}\p{N}_$-]+(?:\.[\p{L}\p{N}_$-]+)+$/u.test(value)
      if (!groupProperty && !looksLikeGlobalPath) return
      const range = literalRange(stringPath.node)
      if (range && value) candidates.push(candidate(value, range, 'exact'))
    },
    TemplateLiteral(templatePath) {
      if (templatePath.node.expressions.length > 0) return
      const idAttribute = templatePath.findParent(
        (parent) =>
          parent.isJSXAttribute() && parent.node.name.type === 'JSXIdentifier' && parent.node.name.name === 'id',
      )
      if (idAttribute) return
      const value = templatePath.node.quasis[0]?.value.cooked?.trim() ?? ''
      const looksLikeGlobalPath =
        /^.+\/surface\/(?:0|[1-9]\d*)$/u.test(value) || /^[\p{L}\p{N}_$-]+(?:\.[\p{L}\p{N}_$-]+)+$/u.test(value)
      if (!looksLikeGlobalPath) return
      const range = literalRange(templatePath.node)
      if (range && value) candidates.push(candidate(value, range, 'exact'))
    },
  })

  const selected = candidates
    .filter(({ start, end }) => selection.start <= end && selection.end >= start)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0]
  return selected ? { kind: selected.kind, match: selected.match, value: selected.value } : null
}
