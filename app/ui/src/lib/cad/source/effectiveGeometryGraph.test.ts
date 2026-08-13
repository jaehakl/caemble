import { describe, expect, it } from 'vitest'
import { createEffectiveGeometryGraph } from './effectiveGeometryGraph'
import {
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
  type GeometrySnapshotModule,
  type LocalGeometryCoordinate,
} from './geometrySnapshot'

const exact = 'caemble:geometry/jlee/common/part@1.0.0' as GeometryCoordinate
const local = 'caemble:geometry/jlee/common/assembly@local' as LocalGeometryCoordinate

async function published(): Promise<GeometrySnapshotModule> {
  const source = 'export const Part = () => <box size={[1, 1, 1]} />'
  const sourceHash = await geometrySourceHash(source)
  const base = {
    geometryVersionId: 1,
    coordinate: exact,
    moduleFormatVersion: 3 as const,
    cadApiVersion: 5 as const,
    description: null,
    source,
    sourceHash,
    imports: [],
  }
  return { ...base, moduleHash: await geometryModuleHash(base) }
}

describe('effective source Geometry graph', () => {
  it('derives entry and module relations only from TSX source', async () => {
    const part = await published()
    const snapshot = createGeometrySnapshot([], [])
    const entry = `import { Assembly } from "${local}"\nexport { Assembly }`
    const graph = await createEffectiveGeometryGraph(
      snapshot,
      {
        [exact]: { source: part.source },
        [local]: {
          source: `import { Part as Child } from "${exact}"\nexport const Assembly = () => <Child id="child" />`,
        },
      },
      entry,
    )
    expect(graph.entryImports).toMatchObject([{ exportName: 'Assembly', alias: 'Assembly', coordinate: local }])
    expect(graph.modules.find((item) => item.coordinate === local)?.imports).toEqual([
      { exportName: 'Part', alias: 'Child', coordinate: exact },
    ])
  })

  it('keeps repeated shared dependency occurrences with their local aliases', async () => {
    const part = await published()
    const graph = await createEffectiveGeometryGraph(
      createGeometrySnapshot([], []),
      {
        [exact]: { source: part.source },
        [local]: {
          source: `import { Part as Left, Part as Right } from "${exact}"\nexport const Assembly = () => <union><Left id="l"/><Right id="r"/></union>`,
        },
      },
      `import { Assembly } from "${local}"\nexport { Assembly }`,
    )
    expect(graph.modules.find((item) => item.coordinate === local)?.imports.map((item) => item.alias)).toEqual([
      'Left',
      'Right',
    ])
  })

  it('rejects unresolved exports, imports and cycles', async () => {
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {},
        `import { Missing } from "${local}"\nexport { Missing }`,
      ),
    ).rejects.toThrow('unresolved')
    const other = 'caemble:geometry/jlee/common/other@local' as LocalGeometryCoordinate
    await expect(
      createEffectiveGeometryGraph(
        createGeometrySnapshot([], []),
        {
          [local]: { source: `import { Other } from "${other}"\nexport const Assembly = () => <Other id="o"/>` },
          [other]: { source: `import { Assembly } from "${local}"\nexport const Other = () => <Assembly id="a"/>` },
        },
        `import { Assembly } from "${local}"\nexport { Assembly }`,
      ),
    ).rejects.toThrow('cycle')
  })
})
