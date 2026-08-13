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
  const source = 'const Block = () => <box size={[1, 1, 1]} />\nexport default Block\n'
  const sourceHash = await geometrySourceHash(source)
  const input = {
    geometryVersionId: 1,
    coordinate,
    moduleFormatVersion: 2 as const,
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
      [{ alias: 'Block', geometryVersionId: 1, coordinate, moduleHash: module.moduleHash }],
      [module],
    )
    const persisted = await createEffectiveGeometryGraph(snapshot)
    const draft = await createEffectiveGeometryGraph(snapshot, {
      [coordinate]: { source: 'const Block = () => <box size={[2, 2, 2]} />\nexport default Block\n' },
    })

    expect(draft.modules[0].source).toContain('[2, 2, 2]')
    expect(draft.modules[0].moduleHash).not.toBe(module.moduleHash)
    expect(draft.graphHash).not.toBe(persisted.graphHash)
  })

  it('builds a standalone draft-only root without a synthetic persisted module', async () => {
    const graph = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      {
        [draftCoordinate]: {
          source: 'const Draft = () => <box size={[1, 1, 1]} />\nexport default Draft\n',
        },
      },
      [{ alias: 'Preview', coordinate: draftCoordinate }],
    )

    expect(graph.roots).toEqual([
      { alias: 'Preview', coordinate: draftCoordinate, moduleHash: graph.modules[0].moduleHash },
    ])
    expect(graph.modules[0].coordinate).toBe(draftCoordinate)
  })

  it('resolves one shared dependency through sibling DAG paths without treating it as a cycle', async () => {
    const graph = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      {
        [coordinate]: { source: 'const Shared = () => <box size={[1, 1, 1]} />\nexport default Shared\n' },
        [leftCoordinate]: {
          source: `import Shared from '${coordinate}'\nconst Left = () => <Shared id="shared" />\nexport default Left\n`,
        },
        [rightCoordinate]: {
          source: `import Shared from '${coordinate}'\nconst Right = () => <Shared id="shared" />\nexport default Right\n`,
        },
        [rootCoordinate]: {
          source: `import Left from '${leftCoordinate}'\nimport Right from '${rightCoordinate}'\nconst Root = () => <union><Left id="left" /><Right id="right" /></union>\nexport default Root\n`,
        },
      },
      [{ alias: 'Root', coordinate: rootCoordinate }],
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
        [coordinate]: { source: 'const Shared = () => <box size={[1, 1, 1]} />\nexport default Shared\n' },
        [leftCoordinate]: {
          source: `import Shared from '${coordinate}'\nconst Left = () => <Shared id="shared" />\nexport default Left\n`,
        },
        [rightCoordinate]: {
          source: `import Shared from '${coordinate}'\nconst Right = () => <Shared id="shared" />\nexport default Right\n`,
        },
      },
      [
        { alias: 'Left', coordinate: leftCoordinate },
        { alias: 'Right', coordinate: rightCoordinate },
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
            source:
              'import Value from \'caemble:geometry/jlee/demo/leaf@latest\'\nconst Draft = () => <Value id="value" />\nexport default Draft',
          },
        },
        [{ alias: 'Preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('exact caemble:geometry coordinate')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [draftCoordinate]: {
            source: `import Value from '${coordinate}'\nconst Draft = () => <Value id="value" />\nexport default Draft`,
          },
        },
        [{ alias: 'Preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('unresolved')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [draftCoordinate]: {
            source: `import Value from '${draftCoordinate}'\nconst Draft = () => <Value id="value" />\nexport default Draft`,
          },
        },
        [{ alias: 'Preview', coordinate: draftCoordinate }],
      ),
    ).rejects.toThrow('dependency cycle')
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [draftCoordinate]: {
            source: `import Value from '${foreignCoordinate}'\nconst Draft = () => <Value id="value" />\nexport default Draft`,
          },
          [foreignCoordinate]: {
            source: 'const Foreign = () => <box size={[1, 1, 1]} />\nexport default Foreign',
          },
        },
        [{ alias: 'Preview', coordinate: draftCoordinate }],
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
              ? 'const Leaf = () => <box size={[1, 1, 1]} />\nexport default Leaf\n'
              : `import Next from '${coordinates[index + 1]}'\nconst Node = () => <Next id="next" />\nexport default Node\n`,
        },
      ]),
    )

    const valid = await createEffectiveGeometryGraph(createGeometrySnapshot([], []), drafts, [
      { alias: 'Shallow', coordinate: coordinates[63] },
      { alias: 'Long', coordinate: coordinates[1] },
    ])
    expect(valid.modules).toHaveLength(64)

    await expect(
      createEffectiveGeometryGraph(createGeometrySnapshot([], []), drafts, [
        { alias: 'Shallow', coordinate: coordinates[63] },
        { alias: 'Long', coordinate: coordinates[0] },
      ]),
    ).rejects.toThrow('dependency depth 64')
  })
})
