import type { CadAuthoringContract, CadElementManifest } from './evaluation/types'

export function buildCadAuthoringReference({
  authoringContract,
  elements,
  experimentSkeleton,
  geometrySkeleton,
}: Readonly<{
  authoringContract: CadAuthoringContract
  elements: readonly CadElementManifest[]
  experimentSkeleton: string
  geometrySkeleton: string
}>) {
  const core = [
    '# Official CAD authoring grammar',
    'Authority: Caemble app contract. Manuals: /docs?section=reference and /docs?section=geometry.',
    '',
    '## Complete experiment.tsx skeleton',
    '```tsx',
    ...experimentSkeleton.trim().split('\n'),
    '```',
    '',
    '## Complete geometry.tsx skeleton',
    '```tsx',
    ...geometrySkeleton.trim().split('\n'),
    '```',
    '',
    '## Authoring conventions',
    '- A scalar `varsSchema` entry uses `{ min, max }`; omitted `shape` defaults to `[]`, and explicit `shape: []` remains valid. Tensors require an explicit shape such as `[3]` or `[4, 4, 1]`.',
    `- New code uses canonical transforms: ${authoringContract.transforms.canonicalProperties.map(({ name, type }) => `\`${name}?: ${type}\``).join(', ')}. ${authoringContract.transforms.rotationConvention} Effective order: ${authoringContract.transforms.applicationOrder.join(', ')}.`,
    '- Group transforms use lowercase `<translate offset={Vec3}>`, `<rotate axis={Vec3} angle={radians(degrees)}>`, and `<scale x={sx} y={sy} z={sz}>`.',
    '- Omitted component/primitive IDs use lower-kebab names plus `-2`, `-3`; use explicit stable IDs for durable targets. Fragment has no `id`.',
    '- A topology-changing operation owns its result `id`; consumed operand IDs are not final solver targets. `array` keeps `$cell-x-y-z` instance identity.',
    '- `surfaceGroup` members use `<geometry-id>/surface/<index>`. Give referenced primitive/Fiber leaves stable IDs and use the numeric slots from the Element reference. Transforms and Boolean results retain source slots; a shell root exposes slot 0 for inner and slot 1 for outer.',
    '- Components inherit the parent Material role map when `materials` is omitted; an explicit map replaces it and `{}` clears it. Primitives consume the `body` role.',
    '- Boolean child order defines the operation: `subtract` uses the first child as base and the rest as cutters.',
    '- Import PascalCase primitives and public APIs from `@caemble/core`; keep operation tags lowercase. Export PascalCase named `Geometry<Props>` components, never a default Geometry export.',
    '- Local `Geometry<Props>` functions use direct destructuring with an initializer for every custom prop; no `props.foo`, rest, computed, or nested patterns.',
    '- Primitive props are optional; omitted/`undefined` uses Catalog defaults. Operation props and child contracts stay required.',
    '- `for`, `map`, and `if` are supported. Use explicit loop IDs; prefer `array` for regular lattices.',
    '',
    '## Element index (canonical syntax)',
    ...elements.map(({ authoringName, syntax }) => `- \`${authoringName}\`: \`${syntax}\``),
  ].join('\n')

  return Object.freeze({
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
          surfaces: Object.freeze(element.surfaces.map((surface) => Object.freeze({ ...surface }))),
          example: element.example,
        }),
      ),
    ),
  })
}
