import type { CadAuthoringContract, CadElementManifest } from './evaluation/types'

export const CAD_AUTHORING_REFERENCE_SCHEMA_VERSION = 1 as const
export const CAD_GRAMMAR_CORE_MAX_BYTES = 5 * 1024

export function buildCadAuthoringReference({
  authoringContract,
  declarationFingerprint,
  elements,
  geometrySkeleton,
}: Readonly<{
  authoringContract: CadAuthoringContract
  declarationFingerprint: string
  elements: readonly CadElementManifest[]
  geometrySkeleton: string
}>) {
  const core = [
    `# Official CAD authoring grammar — API v${authoringContract.apiVersion}`,
    'Authority: Caemble app contract. Manuals: /docs?section=reference and /docs?section=geometry.',
    '',
    '## Complete geometry.tsx skeleton',
    '```tsx',
    ...geometrySkeleton.trim().split('\n'),
    '```',
    '',
    '## Required rules',
    `- New code uses only canonical v${authoringContract.apiVersion} transforms: ${authoringContract.transforms.canonicalProperties.map(({ name, type }) => `\`${name}?: ${type}\``).join(', ')}. ${authoringContract.transforms.rotationConvention} Effective order: ${authoringContract.transforms.applicationOrder.join(', ')}.`,
    '- Group transforms with lowercase `<translate offset={Vec3}>`, `<rotate axis={Vec3} angle={radians(degrees)}>`, and `<scale x={sx} y={sy} z={sz}>`; wrappers reject direct transform props.',
    `- Never generate \`translation\`. ${authoringContract.transforms.legacyProperties.map(({ name }) => `\`${name}\``).join(' and ')} and lowercase primitive JSX are deprecated compatibility syntax; do not emit them. ${authoringContract.transforms.mixing}`,
    '- Omitted component/primitive IDs use lower-kebab names plus `-2`, `-3`; use explicit stable IDs for durable targets. Fragment has no `id`.',
    '- A topology-changing operation owns its result `id`; consumed operand IDs are not final solver targets. `array` keeps `$cell-x-y-z` instance identity.',
    '- Components inherit the parent Material role map when `materials` is omitted; an explicit map replaces it and `{}` clears it. Primitives consume the `body` role.',
    "- Boolean child order matters: `subtract` uses the first child as base and the rest as cutters. Follow each operation's child contract exactly.",
    '- Import PascalCase primitives and public APIs from `@caemble/core`; keep operation tags lowercase. Export PascalCase named `Geometry<Props>` components, never a default Geometry export.',
    '- Local `Geometry<Props>` functions use direct destructuring with an initializer for every custom prop; no `props.foo`, rest, computed, or nested patterns.',
    '- Primitive props are optional; omitted/`undefined` uses Catalog defaults. Operation props and child contracts stay required.',
    '- Bounded deterministic `for`, `map`, and `if` are supported. Use explicit loop IDs; prefer `array` for regular lattices.',
    '',
    '## Element index (canonical syntax)',
    ...elements.map(({ authoringName, syntax }) => `- \`${authoringName}\`: \`${syntax}\``),
  ].join('\n')

  if (new TextEncoder().encode(core).byteLength > CAD_GRAMMAR_CORE_MAX_BYTES) {
    throw new Error(
      `Official CAD grammar core exceeds ${CAD_GRAMMAR_CORE_MAX_BYTES} UTF-8 bytes. Move element detail to the reference tool.`,
    )
  }

  return Object.freeze({
    schemaVersion: CAD_AUTHORING_REFERENCE_SCHEMA_VERSION,
    apiVersion: authoringContract.apiVersion,
    declarationFingerprint,
    core,
    elements: Object.freeze(
      elements.map((element) =>
        Object.freeze({
          tag: element.tag,
          authoringName: element.authoringName,
          category: element.category,
          standardTransforms: element.standardTransforms,
          syntax: element.syntax,
          summary: element.summary,
          keywords: Object.freeze([...element.keywords]),
          properties: Object.freeze(element.properties.map((property) => Object.freeze({ ...property }))),
          children: Object.freeze({ ...element.children }),
          origin: element.origin,
          surfaces: Object.freeze([...element.surfaces]),
          example: element.example,
        }),
      ),
    ),
  })
}
