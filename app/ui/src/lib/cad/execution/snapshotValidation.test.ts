import { describe, expect, it } from 'vitest'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import { Material } from '../model/core'
import { serializeEvaluatedDocumentSnapshot } from './snapshot'
import { assertEvaluatedDocumentSnapshot, assertPlainSnapshotValue } from './snapshotValidation'

function Box() {
  return h('box', { size: [1, 1, 1] })
}

describe('plain snapshot validation', () => {
  it('accepts shared plain values while preserving their aliases', () => {
    const shared = Object.freeze({ color: '#2563eb' })
    const value = { first: shared, second: shared }

    expect(() => assertPlainSnapshotValue(value)).not.toThrow()
    const cloned = structuredClone(value)
    expect(cloned.first).toBe(cloned.second)
  })

  it('rejects direct and indirect cycles', () => {
    const direct: Record<string, unknown> = {}
    direct.self = direct
    const parent: Record<string, unknown> = {}
    const child: Record<string, unknown> = { parent }
    parent.child = child

    expect(() => assertPlainSnapshotValue(direct)).toThrow('snapshot.self contains a cyclic value')
    expect(() => assertPlainSnapshotValue(parent)).toThrow('snapshot.child.parent contains a cyclic value')
  })

  it('validates a serialized scene whose parts share one Material realization', () => {
    const material = new Material('Shared', { color: '#2563eb' })
    const scene = evaluateCadScene(
      h(
        Fragment,
        null,
        h(Box, { id: 'first', materials: [material] }),
        h(Box, { id: 'second', pos: [2, 0, 0], materials: [material] }),
      ),
    )
    const snapshot = serializeEvaluatedDocumentSnapshot({
      kind: 'structure',
      scene,
      seed: 7,
      sourceHash: 'a'.repeat(64),
      variables: {},
      varsSchema: {},
    })

    expect(snapshot.scene.parts[0].material).toBe(snapshot.scene.parts[1].material)
    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()

    const cloned = structuredClone(snapshot)
    expect(cloned.scene.parts[0].material).toBe(cloned.scene.parts[1].material)
    expect(() => assertEvaluatedDocumentSnapshot(cloned)).not.toThrow()
  })

  it('requires varsSchema and validates variables against it', () => {
    const snapshot = {
      kind: 'structure' as const,
      scene: evaluateCadScene(h(Box, { id: 'box' })),
      seed: 7,
      sourceHash: 'a'.repeat(64),
      variables: { width: 4 },
      varsSchema: { width: { min: 1, max: 10 } },
    }

    expect(() => assertEvaluatedDocumentSnapshot(serializeEvaluatedDocumentSnapshot(snapshot))).not.toThrow()
    const missingSchema: Record<string, unknown> = { ...snapshot }
    delete missingSchema.varsSchema
    expect(() => assertEvaluatedDocumentSnapshot(missingSchema)).toThrow(
      'Evaluated document snapshot varsSchema must be an object',
    )
    expect(() => assertEvaluatedDocumentSnapshot({ ...snapshot, variables: { width: 20 } })).toThrow(
      'vars.width must be less than or equal to 10',
    )
  })
})
