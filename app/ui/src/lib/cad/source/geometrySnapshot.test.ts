import { describe, expect, it } from 'vitest'
import {
  assertGeometrySnapshot,
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  validateGeometrySnapshotHashes,
  type GeometryCoordinate,
  type GeometrySnapshotImport,
  type GeometrySnapshotModule,
} from './geometrySnapshot'

const hash = 'a'.repeat(64)
const leafCoordinate = 'caemble:geometry/jlee/common/leaf@1.0.0' as GeometryCoordinate
const rootCoordinate = 'caemble:geometry/jlee/common/root@1.0.0' as GeometryCoordinate

async function module(
  id: number,
  coordinate: GeometryCoordinate,
  source: string,
  imports: readonly GeometrySnapshotImport[] = [],
): Promise<GeometrySnapshotModule> {
  const sourceHash = await geometrySourceHash(source)
  const value = {
    geometryVersionId: id,
    coordinate,
    moduleFormatVersion: 4 as const,
    cadApiVersion: 7 as const,
    description: null,
    source,
    sourceHash,
    moduleHash: '',
    imports,
  }
  return { ...value, moduleHash: await geometryModuleHash(value) }
}

describe('Geometry snapshot v2', () => {
  it('canonicalizes entry and module imports by alias, export and coordinate', async () => {
    const leaf = await module(1, leafCoordinate, 'export const Part = () => <box size={[1, 1, 1]} />')
    const imported = {
      exportName: 'Part',
      alias: 'Child',
      geometryVersionId: 1,
      coordinate: leafCoordinate,
      moduleHash: leaf.moduleHash,
    }
    const root = await module(
      2,
      rootCoordinate,
      `import { Part as Child } from "${leafCoordinate}"\nexport const Assembly = () => <Child id="child" />`,
      [imported],
    )
    const snapshot = createGeometrySnapshot(
      [
        {
          exportName: 'Assembly',
          alias: 'Assembly',
          geometryVersionId: 2,
          coordinate: rootCoordinate,
          moduleHash: root.moduleHash,
        },
      ],
      [root, leaf],
    )
    expect(snapshot.schemaVersion).toBe(2)
    expect(snapshot.modules.map((item) => item.coordinate)).toEqual([leafCoordinate, rootCoordinate])
    await expect(validateGeometrySnapshotHashes(snapshot)).resolves.toBeUndefined()
  })

  it('allows one target through different aliases and exports but rejects duplicate aliases', async () => {
    const leaf = await module(
      1,
      leafCoordinate,
      'export const Left = () => <box />\nexport const Right = () => <sphere />',
    )
    const left = {
      exportName: 'Left',
      alias: 'A',
      geometryVersionId: 1,
      coordinate: leafCoordinate,
      moduleHash: leaf.moduleHash,
    }
    const right = { ...left, exportName: 'Right', alias: 'B' }
    const root = await module(2, rootCoordinate, 'export const Assembly = () => <box />', [left, right])
    expect(() =>
      createGeometrySnapshot(
        [
          {
            exportName: 'Assembly',
            alias: 'Assembly',
            geometryVersionId: 2,
            coordinate: rootCoordinate,
            moduleHash: root.moduleHash,
          },
        ],
        [leaf, root],
      ),
    ).not.toThrow()
    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 2,
        entryImports: [{ ...left }, { ...right, alias: 'A' }],
        modules: [leaf],
      }),
    ).toThrow('aliases must be unique')
  })

  it('rejects unresolved, orphaned, cyclic and non-v4 modules', async () => {
    const leaf = await module(1, leafCoordinate, 'export const Part = () => <box />')
    const entry = {
      exportName: 'Part',
      alias: 'Part',
      geometryVersionId: 1,
      coordinate: leafCoordinate,
      moduleHash: leaf.moduleHash,
    }
    expect(() => assertGeometrySnapshot({ schemaVersion: 2, entryImports: [entry], modules: [] })).toThrow(
      'does not match',
    )
    expect(() => assertGeometrySnapshot({ schemaVersion: 2, entryImports: [], modules: [leaf] })).toThrow(
      'not reachable',
    )
    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 2,
        entryImports: [entry],
        modules: [{ ...leaf, moduleFormatVersion: 2 }],
      }),
    ).toThrow('format version 4')
    expect(() => assertGeometrySnapshot({ schemaVersion: 1, entryImports: [], modules: [] })).toThrow(
      'schema version 2',
    )
  })

  it('hashes only canonical source and import provenance', async () => {
    const sourceHash = await geometrySourceHash('export const Shape = () => <box />')
    const left = await geometryModuleHash({
      coordinate: rootCoordinate,
      sourceHash,
      moduleFormatVersion: 4,
      cadApiVersion: 7,
      imports: [
        { exportName: 'Part', alias: 'Child', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: hash },
      ],
    })
    const right = await geometryModuleHash({
      coordinate: rootCoordinate,
      sourceHash,
      moduleFormatVersion: 4,
      cadApiVersion: 7,
      imports: [
        { exportName: 'Part', alias: 'Other', geometryVersionId: 999, coordinate: leafCoordinate, moduleHash: hash },
      ],
    })
    expect(left).not.toBe(right)
  })
})
