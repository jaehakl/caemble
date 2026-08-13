import { describe, expect, it } from 'vitest'
import {
  assertGeometrySnapshot,
  assertCanonicalGeometrySnapshot,
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  isGeometryCoordinate,
  validateGeometrySnapshotHashes,
  type GeometryCoordinate,
  type GeometrySnapshotImport,
  type GeometrySnapshotModule,
} from './geometrySnapshot'

const leafCoordinate = 'caemble:geometry/jlee/demo/leaf@1.0.0' as GeometryCoordinate
const rootCoordinate = 'caemble:geometry/jlee/demo/root@2.0.0' as GeometryCoordinate

async function module(
  geometryVersionId: number,
  coordinate: GeometryCoordinate,
  source: string,
  imports: GeometrySnapshotImport[] = [],
): Promise<GeometrySnapshotModule> {
  const sourceHash = await geometrySourceHash(source)
  const input = {
    geometryVersionId,
    coordinate,
    moduleFormatVersion: 2 as const,
    cadApiVersion: 5 as const,
    description: null,
    source,
    sourceHash,
    imports,
  }
  return { ...input, moduleHash: await geometryModuleHash(input) }
}

describe('Geometry snapshot v1', () => {
  it('uses the database-safe SemVer and namespace coordinate contract', () => {
    expect(isGeometryCoordinate('caemble:geometry/jlee/demo/part@2147483647.0.0')).toBe(true)
    expect(isGeometryCoordinate('caemble:geometry/jlee/demo/part@2147483648.0.0')).toBe(false)
    expect(isGeometryCoordinate('caemble:geometry/j/demo/part@1.0.0')).toBe(false)
  })

  it('hashes raw UTF-8 source and canonical Merkle imports', async () => {
    expect(await geometrySourceHash('한\n')).not.toBe(await geometrySourceHash('한\r\n'))
    expect(() => geometrySourceHash('\ud800')).toThrow('valid UTF-8')
    const left = { geometryVersionId: 2, coordinate: rootCoordinate, moduleHash: 'b'.repeat(64) }
    const right = { geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: 'a'.repeat(64) }
    const input = {
      moduleFormatVersion: 2 as const,
      cadApiVersion: 5 as const,
      description: null,
      coordinate: rootCoordinate,
      sourceHash: 'c'.repeat(64),
      imports: [left, right],
    }
    await expect(geometryModuleHash(input)).resolves.toBe(
      '8ac018cced8bc8f9ee9bd4d57c7038432ae651aa2d602d37ac860446d4f306fc',
    )
    await expect(geometryModuleHash({ ...input, imports: [right, left] })).resolves.toBe(
      '8ac018cced8bc8f9ee9bd4d57c7038432ae651aa2d602d37ac860446d4f306fc',
    )
  })

  it('canonicalizes roots, modules, and imports and validates their hashes', async () => {
    const leaf = await module(1, leafCoordinate, 'const Leaf = () => <box size={[1, 1, 1]} />\nexport default Leaf\n')
    const imported = { geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash }
    const root = await module(
      2,
      rootCoordinate,
      `import Leaf from '${leafCoordinate}'\nconst Root = () => <union><Leaf id="leaf" /></union>\nexport default Root\n`,
      [imported],
    )
    const snapshot = createGeometrySnapshot(
      [
        { alias: 'ZRoot', geometryVersionId: 2, coordinate: rootCoordinate, moduleHash: root.moduleHash },
        { alias: 'ARoot', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash },
      ],
      [root, leaf],
    )

    expect(snapshot.roots.map((item) => item.alias)).toEqual(['ARoot', 'ZRoot'])
    expect(snapshot.modules.map((item) => item.coordinate)).toEqual([leafCoordinate, rootCoordinate])
    expect(() => assertCanonicalGeometrySnapshot({ ...snapshot, roots: [...snapshot.roots].reverse() })).toThrow(
      'sorted by alias',
    )
    await expect(validateGeometrySnapshotHashes(snapshot)).resolves.toBeUndefined()
    await expect(
      validateGeometrySnapshotHashes({
        ...snapshot,
        modules: snapshot.modules.map((item) =>
          item.coordinate === leafCoordinate ? { ...item, source: `${item.source}\n` } : item,
        ),
      }),
    ).rejects.toThrow('sourceHash')
  })

  it('rejects unresolved projections, orphans, duplicate aliases, and cycles', () => {
    const leaf = {
      geometryVersionId: 1,
      coordinate: leafCoordinate,
      moduleFormatVersion: 2 as const,
      cadApiVersion: 5 as const,
      description: null,
      source: 'x',
      sourceHash: 'a'.repeat(64),
      moduleHash: 'b'.repeat(64),
      imports: [],
    }
    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 1,
        roots: [{ alias: 'Root', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: 'c'.repeat(64) }],
        modules: [leaf],
      }),
    ).toThrow('root projection')
    expect(() => assertGeometrySnapshot({ schemaVersion: 1, roots: [], modules: [leaf] })).toThrow('not reachable')
    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 1,
        roots: [
          { alias: 'Same', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash },
          { alias: 'Same', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash },
        ],
        modules: [leaf],
      }),
    ).toThrow('aliases must be unique')
    const cyclic = {
      ...leaf,
      imports: [{ geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash }],
    }
    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 1,
        roots: [{ alias: 'Root', geometryVersionId: 1, coordinate: leafCoordinate, moduleHash: leaf.moduleHash }],
        modules: [cyclic],
      }),
    ).toThrow('dependency cycle')
  })

  it('rejects a depth-65 path when its shared tail was first visited from a shallow root', () => {
    const coordinates = Array.from(
      { length: 65 },
      (_, index) => `caemble:geometry/jlee/demo/node-${index}@1.0.0` as GeometryCoordinate,
    )
    const modules = coordinates.map((coordinate, index) => ({
      geometryVersionId: index + 1,
      coordinate,
      moduleFormatVersion: 2 as const,
      cadApiVersion: 5 as const,
      description: null,
      source: 'x',
      sourceHash: 'a'.repeat(64),
      moduleHash: 'b'.repeat(64),
      imports:
        index === coordinates.length - 1
          ? []
          : [
              {
                geometryVersionId: index + 2,
                coordinate: coordinates[index + 1],
                moduleHash: 'b'.repeat(64),
              },
            ],
    }))

    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 1,
        roots: [
          {
            alias: 'Shallow',
            geometryVersionId: modules[63].geometryVersionId,
            coordinate: coordinates[63],
            moduleHash: 'b'.repeat(64),
          },
          {
            alias: 'Long',
            geometryVersionId: modules[1].geometryVersionId,
            coordinate: coordinates[1],
            moduleHash: 'b'.repeat(64),
          },
        ],
        modules: modules.slice(1),
      }),
    ).not.toThrow()

    expect(() =>
      assertGeometrySnapshot({
        schemaVersion: 1,
        roots: [
          { alias: 'Shallow', geometryVersionId: 64, coordinate: coordinates[63], moduleHash: 'b'.repeat(64) },
          { alias: 'Long', geometryVersionId: 1, coordinate: coordinates[0], moduleHash: 'b'.repeat(64) },
        ],
        modules,
      }),
    ).toThrow('dependency depth 64')
  })
})
