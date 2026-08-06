import { geometries } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { h } from '../evaluation/jsx'
import { evaluateCadScene } from '../evaluation/evaluator'
import { assertSerializableCadScene, cadSnapshotTransferables, deserializeCadScene, serializeCadScene } from './mesh'

function scene(size: readonly [number, number, number]) {
  function Box() {
    return h('box', { size })
  }
  return evaluateCadScene(h(Box, { id: 'box' }), {}, 'Structure', 'mm')
}

describe('typed CAD scene snapshots', () => {
  it('serializes geom3 solids into validated typed buffers and restores them', () => {
    const serialized = serializeCadScene(scene([2, 3, 4]))

    expect(serialized.sceneHash).toMatch(/^[0-9a-f]{64}$/)
    expect(serialized.parts[0].geometry.positions).toBeInstanceOf(Float64Array)
    expect(serialized.parts[0].geometry.polygonOffsets).toBeInstanceOf(Uint32Array)
    expect(() => assertSerializableCadScene(serialized)).not.toThrow()
    expect(cadSnapshotTransferables(serialized)).toHaveLength(2)

    const restored = deserializeCadScene(serialized)
    expect(geometries.geom3.isA(restored.parts[0].geometry)).toBe(true)
    expect(
      geometries.geom3.toPolygons(restored.parts[0].geometry as Parameters<typeof geometries.geom3.toPolygons>[0]),
    ).toHaveLength(6)
    expect(deserializeCadScene(serialized)).toBe(restored)
  })

  it('hashes the actual mesh bytes and rejects tampered geometry', () => {
    const first = serializeCadScene(scene([2, 3, 4]))
    const repeated = serializeCadScene(scene([2, 3, 4]))
    const changed = serializeCadScene(scene([4, 3, 2]))

    expect(repeated.sceneHash).toBe(first.sceneHash)
    expect(changed.sceneHash).not.toBe(first.sceneHash)
    first.parts[0].geometry.positions[0] += 1
    expect(() => assertSerializableCadScene(first)).toThrow('does not match its hash')
  })
})
