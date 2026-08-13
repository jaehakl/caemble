import { describe, expect, it } from 'vitest'
import { createEffectiveGeometryGraph } from './effectiveGeometryGraph'
import {
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
  type GeometrySnapshotModule,
} from './geometrySnapshot'

const coordinate = 'caemble:geometry/jlee/demo/block@1.0.0' as GeometryCoordinate
const draftCoordinate = 'caemble:geometry/jlee/demo/draft@0.1.0' as GeometryCoordinate
const foreignCoordinate = 'caemble:geometry/other/demo/leaf@1.0.0' as GeometryCoordinate
const leftCoordinate = 'caemble:geometry/jlee/demo/left@1.0.0' as GeometryCoordinate
const rightCoordinate = 'caemble:geometry/jlee/demo/right@1.0.0' as GeometryCoordinate
const rootCoordinate = 'caemble:geometry/jlee/demo/root@1.0.0' as GeometryCoordinate

async function publishedModule(): Promise<GeometrySnapshotModule> {
  const source = 'export default <box size={[1, 1, 1]} />\n'
  const sourceHash = await geometrySourceHash(source)
  const input = {
    geometryVersionId: 1,
    coordinate,
    moduleFormatVersion: 1 as const,
    cadApiVersion: 5 as const,
    description: null,
    source,
    sourceHash,
    imports: [],
  }
  return { ...input, moduleHash: await geometryModuleHash(input) }
}

describe('Effective Geometry graph', () => {
  it('overlays every occurrence of an exact coordinate and invalidates graph hashes', async () => {
    const module = await publishedModule()
    const snapshot = createGeometrySnapshot(
      [{ alias: 'block', geometryVersionId: 1, coordinate, moduleHash: module.moduleHash }],
      [module],
    )
    const persisted = await createEffectiveGeometryGraph(snapshot)
    const draft = await createEffectiveGeometryGraph(snapshot, {
      [coordinate]: { source: 'export default <box size={[2, 2, 2]} />\n' },
    })

    expect(draft.modules[0].source).toContain('[2, 2, 2]')
    expect(draft.modules[0].moduleHash).not.toBe(module.moduleHash)
    expect(draft.graphHash).not.toBe(persisted.graphHash)
  })

  it('builds a standalone draft-only root without a synthetic persisted module', async () => {
    const graph = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      { [draftCoordinate]: { source: 'export default <box size={[1, 1, 1]} />\n' } },
      [{ alias: 'preview', coordinate: draftCoordinate }],
    )

    expect(graph.roots).toEqual([
      { alias: 'preview', coordinate: draftCoordinate, moduleHash: graph.modules[0].moduleHash },
    ])
    expect(graph.modules[0].coordinate).toBe(draftCoordinate)
  })

  it('resolves one shared dependency through sibling DAG paths without treating it as a cycle', async () => {
    const graph = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      {
        [coordinate]: { source: 'export default <box size={[1, 1, 1]} />\n' },
        [leftCoordinate]: { source: `import shared from '${coordinate}'\nexport default shared\n` },
        [rightCoordinate]: { source: `import shared from '${coordinate}'\nexport default shared\n` },
        [rootCoordinate]: {
          source: `import left from '${leftCoordinate}'\nimport right from '${rightCoordinate}'\nexport default <union>{left}{right}</union>\n`,
        },
      },
      [{ alias: 'root', coordinate: rootCoordinate }],
    )

    expect(graph.modules.map((module) => module.coordinate)).toEqual([
      coordinate,
      leftCoordinate,
      rightCoordinate,
      rootCoordinate,
    ])

    const twoRoots = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      {
        [coordinate]: { source: 'export default <box size={[1, 1, 1]} />\n' },
        [leftCoordinate]: { source: `import shared from '${coordinate}'\nexport default shared\n` },
        [rightCoordinate]: { source: `import shared from '${coordinate}'\nexport default shared\n` },
      },
      [
        { alias: 'left', coordinate: leftCoordinate },
        { alias: 'right', coordinate: rightCoordinate },
      ],
    )
    expect(twoRoots.modules).toHaveLength(3)
  })

  it('rejects floating, unresolved, and cyclic draft imports', async () => {
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [draftCoordinate]: {
            source: "import value from 'caemble:geometry/jlee/demo/leaf@latest'\nexport default value",
          },
        },
        [{ alias: 'preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('exact caemble:geometry coordinate')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        { [draftCoordinate]: { source: `import value from '${coordinate}'\nexport default value` } },
        [{ alias: 'preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('unresolved')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        { [draftCoordinate]: { source: `import value from '${draftCoordinate}'\nexport default value` } },
        [{ alias: 'preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('dependency cycle')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [draftCoordinate]: {
            source: `import value from '${foreignCoordinate}'\nexport default value`,
          },
          [foreignCoordinate]: { source: 'export default <box size={[1, 1, 1]} />' },
        },
        [{ alias: 'preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('crosses owner namespaces')
  })

  it('rejects a depth-65 draft path when its shared tail was built first as a shallow root', async () => {
    const coordinates = Array.from(
      { length: 65 },
      (_, index) => `caemble:geometry/jlee/demo/node-${index}@1.0.0` as GeometryCoordinate,
    )
    const drafts = Object.fromEntries(
      coordinates.map((coordinate, index) => [
        coordinate,
        {
          source:
            index === coordinates.length - 1
              ? 'export default <box size={[1, 1, 1]} />\n'
              : `import next from '${coordinates[index + 1]}'\nexport default next\n`,
        },
      ]),
    )

    const valid = await createEffectiveGeometryGraph(createGeometrySnapshot([], []), drafts, [
      { alias: 'shallow', coordinate: coordinates[63] },
      { alias: 'long', coordinate: coordinates[1] },
    ])
    expect(valid.modules).toHaveLength(64)

    await expect(
      createEffectiveGeometryGraph(createGeometrySnapshot([], []), drafts, [
        { alias: 'shallow', coordinate: coordinates[63] },
        { alias: 'long', coordinate: coordinates[0] },
      ]),
    ).rejects.toThrow('dependency depth 64')
  })
})
