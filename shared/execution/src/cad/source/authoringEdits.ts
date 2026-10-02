import { parse } from '@babel/parser'
import type { ImportDeclaration, ImportSpecifier, Statement } from '@babel/types'
import { cadAuthoringContract, cadElementCatalog } from '../catalog'
import type { CadElementManifest } from '../evaluation/types'

export type CadAuthoringEditResult = Readonly<{
  source: string
  cursorOffset: number
}>

export const primitiveAuthoringElements = cadElementCatalog.filter((element) => element.category === 'primitive')
export const operationAuthoringElements = cadElementCatalog.filter((element) => element.category === 'operation')

function lowerKebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
}

function nextId(source: string, authoringName: string) {
  const base = lowerKebab(authoringName) || 'geometry'
  const ids = new Set([...source.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]))
  if (!ids.has(base)) return base
  let ordinal = 2
  while (ids.has(`${base}-${ordinal}`)) ordinal += 1
  return `${base}-${ordinal}`
}

function propertyLines(element: CadElementManifest, id: string) {
  const properties = [
    { ...cadAuthoringContract.identity, authoringValue: JSON.stringify(id) },
    ...element.properties,
    ...(element.standardTransforms ? cadAuthoringContract.transforms.canonicalProperties : []),
  ]
  return properties.map(({ name, authoringValue }) =>
    name === 'id' ? `id=${authoringValue}` : `${name}={${authoringValue}}`,
  )
}

function renderPrimitive(element: CadElementManifest, binding: string, id: string) {
  const props = propertyLines(element, id)
    .map((property) => `  ${property}`)
    .join('\n')
  return `<${binding}\n${props}\n/>`
}

function renderOperation(element: CadElementManifest, id: string, selected: string, baseIndent: string) {
  const props = propertyLines(element, id)
    .map((property) => `${baseIndent}  ${property}`)
    .join('\n')
  const lines: string[] = selected.replace(/\r\n/gu, '\n').split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  while (lines[lines.length - 1]?.trim() === '') lines.pop()
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[\t ]*/u)?.[0].length ?? 0)
  const commonIndent = indents.length ? Math.min(...indents) : 0
  const children = lines.map((line) => `${baseIndent}  ${line.slice(commonIndent)}`).join('\n')
  return `<${element.authoringName}\n${props}\n${baseIndent}>\n${children}\n${baseIndent}</${element.authoringName}>`
}

function importedName(specifier: ImportSpecifier) {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

function collectTopLevelBindings(statements: readonly Statement[]) {
  const names = new Set<string>()
  const collect = (statement: Statement) => {
    if (statement.type === 'ImportDeclaration') {
      statement.specifiers.forEach((specifier) => names.add(specifier.local.name))
      return
    }
    if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
      if (statement.declaration && statement.declaration.type !== 'TSInterfaceDeclaration') {
        collect(statement.declaration as Statement)
      } else if (statement.declaration?.id) {
        names.add(statement.declaration.id.name)
      }
      return
    }
    if (
      statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSTypeAliasDeclaration' ||
      statement.type === 'TSEnumDeclaration' ||
      statement.type === 'TSModuleDeclaration'
    ) {
      const id = statement.id
      if (id?.type === 'Identifier') names.add(id.name)
      return
    }
    if (statement.type === 'VariableDeclaration') {
      statement.declarations.forEach((declaration) => {
        if (declaration.id.type === 'Identifier') names.add(declaration.id.name)
      })
    }
  }
  statements.forEach(collect)
  return names
}

function safeAlias(preferred: string, occupied: ReadonlySet<string>) {
  if (!occupied.has(preferred)) return preferred
  const base = `Caemble${preferred}`
  if (!occupied.has(base)) return base
  let ordinal = 2
  while (occupied.has(`${base}${ordinal}`)) ordinal += 1
  return `${base}${ordinal}`
}

function addImportAt(source: string, offset: number, code: string) {
  const prefix = offset > 0 && source[offset - 1] !== '\n' ? '\n' : ''
  const suffix = source[offset] === '\n' ? '' : offset === source.length ? '\n' : '\n\n'
  const text = `${prefix}${code}${suffix}`
  return {
    source: `${source.slice(0, offset)}${text}${source.slice(offset)}`,
    mapOffset: (value: number) => (value >= offset ? value + text.length : value),
  }
}

function ensurePrimitiveImport(source: string, cursorOffset: number, authoringName: string) {
  try {
    const program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }).program
    const coreImports = program.body.filter(
      (statement): statement is ImportDeclaration =>
        statement.type === 'ImportDeclaration' && statement.source.value === '@caemble/core',
    )
    for (const declaration of coreImports) {
      const existing = declaration.specifiers.find(
        (specifier): specifier is ImportSpecifier =>
          specifier.type === 'ImportSpecifier' &&
          declaration.importKind !== 'type' &&
          specifier.importKind !== 'type' &&
          importedName(specifier) === authoringName,
      )
      if (existing) return { source, cursorOffset, binding: existing.local.name }
    }

    const occupied = collectTopLevelBindings(program.body)
    const binding = safeAlias(authoringName, occupied)
    const specifier = binding === authoringName ? authoringName : `${authoringName} as ${binding}`
    const valueImport = coreImports.find(
      (declaration) =>
        declaration.importKind !== 'type' && declaration.specifiers.some((item) => item.type === 'ImportSpecifier'),
    )
    if (valueImport?.start !== null && valueImport?.end != null) {
      const closingBrace = source.lastIndexOf('}', valueImport.end)
      if (closingBrace >= (valueImport.start ?? 0)) {
        const beforeBrace = source.slice(valueImport.start ?? 0, closingBrace)
        const trailingWhitespace = beforeBrace.match(/\s*$/u)?.[0] ?? ''
        const insertionOffset = closingBrace - trailingWhitespace.length
        const previous = source.slice(valueImport.start ?? 0, insertionOffset)
        const separator = previous.endsWith('{') || previous.endsWith(',') ? ' ' : ', '
        const insertion = `${separator}${specifier}`
        return {
          source: `${source.slice(0, insertionOffset)}${insertion}${source.slice(insertionOffset)}`,
          cursorOffset: cursorOffset >= insertionOffset ? cursorOffset + insertion.length : cursorOffset,
          binding,
        }
      }
    }

    const imports = program.body.filter((statement) => statement.type === 'ImportDeclaration')
    const lastImport = imports[imports.length - 1]
    const insertionOffset = lastImport?.end ?? 0
    const result = addImportAt(source, insertionOffset, `import { ${specifier} } from '@caemble/core'`)
    return { source: result.source, cursorOffset: result.mapOffset(cursorOffset), binding }
  } catch {
    const occupied = new Set(
      [
        ...source.matchAll(/\b(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gu),
      ].map((match) => match[1]),
    )
    const binding = safeAlias(authoringName, occupied)
    const specifier = binding === authoringName ? authoringName : `${authoringName} as ${binding}`
    const result = addImportAt(source, 0, `import { ${specifier} } from '@caemble/core'`)
    return { source: result.source, cursorOffset: result.mapOffset(cursorOffset), binding }
  }
}

export function insertPrimitiveAfterCursorLine(
  source: string,
  cursorOffset: number,
  element: CadElementManifest,
): CadAuthoringEditResult {
  const imported = ensurePrimitiveImport(source, cursorOffset, element.authoringName)
  const lineStart = imported.source.lastIndexOf('\n', Math.max(0, imported.cursorOffset - 1)) + 1
  const nextLineBreak = imported.source.indexOf('\n', imported.cursorOffset)
  const lineEnd = nextLineBreak === -1 ? imported.source.length : nextLineBreak
  const indent = imported.source.slice(lineStart, lineEnd).match(/^[\t ]*/u)?.[0] ?? ''
  const id = nextId(imported.source, element.authoringName)
  const snippet = renderPrimitive(element, imported.binding, id)
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n')
  const insertion = `\n${snippet}`
  return {
    source: `${imported.source.slice(0, lineEnd)}${insertion}${imported.source.slice(lineEnd)}`,
    cursorOffset: lineEnd + insertion.length,
  }
}

export function wrapSelectionWithOperation(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  element: CadElementManifest,
): CadAuthoringEditResult | null {
  const selected = source.slice(selectionStart, selectionEnd)
  if (!selected.trim()) return null
  const lineStart = source.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1
  const prefix = source.slice(lineStart, selectionStart)
  const outsideIndent = /^[\t ]*$/u.test(prefix) ? prefix : ''
  const selectedIndent =
    outsideIndent === '' && selectionStart === lineStart ? (selected.match(/^[\t ]*/u)?.[0] ?? '') : outsideIndent
  const replacement = `${outsideIndent === '' && selectionStart === lineStart ? selectedIndent : ''}${renderOperation(
    element,
    nextId(source, element.authoringName),
    selected,
    selectedIndent,
  )}`
  return {
    source: `${source.slice(0, selectionStart)}${replacement}${source.slice(selectionEnd)}`,
    cursorOffset: selectionStart + replacement.length,
  }
}
