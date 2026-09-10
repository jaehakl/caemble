// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createAttachmentDataTensor,
  createDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
} from '@/lib/cad/model/dataTensor'
import type { DataSchema, RecordedData, RecordedDataRule } from '@/lib/cad/model'
import {
  createMeshFieldRenderData,
  parseRecordedMeshFields,
  type MeshFieldView,
  type RecordedMeshField,
} from './meshFields'

const view: MeshFieldView = {
  component: 'magnitude',
  wireframe: true,
  overlays: true,
  clipAxis: -1,
  clipFraction: 0.5,
  deformationScale: 0,
}

function fixture(stress = false) {
  const entries: [string, unknown][] = [
    ['domain.kind', 'unstructured-mesh'],
    ['domain.identity', 'model1'],
    ['domain.lengthUnit', 'm'],
    [
      'domain.points',
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    ],
    ['domain.cells.tet4', [[0, 1, 2, 3]]],
    ['domain.metadata.cellRegions', [0]],
    ['domain.metadata.regionIds', ['steel']],
    ['domain.metadata.supportNodes', [0]],
    ['domain.metadata.loadPoints', [[1, 0, 0]]],
    ['domain.metadata.loadVectors', [[0, 1, 0]]],
    ['location', stress ? 'cell' : 'node'],
    ['quantity', stress ? 'Pressure' : 'kinematics.Displacement'],
    ['valueUnit', stress ? 'Pa' : 'm'],
    [
      'values',
      stress
        ? [[10, 0, 0, 0, 0, 0]]
        : [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
    ],
  ]
  const rules: RecordedDataRule[] = []
  const data: Record<string, unknown> = {}
  for (const [member, value] of entries) {
    const label = `field.${member}`
    const shape = Array.isArray(value) ? [value.length, ...(Array.isArray(value[0]) ? [value[0].length] : [])] : []
    const schema = {
      dtype:
        typeof value === 'string' || member.endsWith('regionIds')
          ? 'string'
          : member.includes('cells') || member.endsWith('cellRegions') || member.endsWith('supportNodes')
            ? 'int32'
            : 'float64',
      axes: shape.map((length) => ({ length })),
    } as DataSchema
    rules.push({ label, methodId: 'test', target: [], parameters: {}, result: schema })
    data[label] = createDataTensor(schema, { value: value as Parameters<typeof createDataTensor>[1]['value'] })
  }
  return { rules, data: data as RecordedData }
}

describe('recorded mesh fields', () => {
  it('restores mesh identity, values, semantic metadata and exterior faces', () => {
    const input = fixture()
    const result = parseRecordedMeshFields(input.rules, input.data)
    expect(result.errors).toEqual([])
    expect(result.fields).toHaveLength(1)
    const field = result.fields[0]
    expect(field.identity).toBe('model1')
    expect(field.boundaryFaces).toHaveLength(12)
    expect(field.boundaryCells).toEqual(new Uint32Array(4))
    expect(field.regionIds).toEqual(['steel'])
    const rendered = createMeshFieldRenderData(field, { ...view, overlays: false }, 'mm')
    expect(rendered.bounds.max).toEqual([1000, 1000, 1000])
    expect(rendered.geometries[0].positions).toHaveLength(36)
    expect(rendered.minimum).toBe(0)
    expect(rendered.maximum).toBe(1)
    // Python retains the trailing vector dimension even when no loads are present.
    const emptyOverlays: RecordedData = {
      ...input.data,
      'field.domain.metadata.supportNodes': { shape: [0], storage: { kind: 'inline', value: [] } },
      'field.domain.metadata.loadPoints': { shape: [0, 3], storage: { kind: 'inline', value: [] } },
      'field.domain.metadata.loadVectors': { shape: [0, 3], storage: { kind: 'inline', value: [] } },
    }
    const empty = parseRecordedMeshFields(input.rules, emptyOverlays)
    expect(empty.errors).toEqual([])
    expect(empty.fields[0].loadPoints).toHaveLength(0)
    expect(createMeshFieldRenderData(empty.fields[0], view).geometries).toHaveLength(2)
  })

  it('uses cell stress values, von Mises and interpolated section caps', () => {
    const input = fixture(true)
    const field = parseRecordedMeshFields(input.rules, input.data).fields[0]
    const rendered = createMeshFieldRenderData(field, {
      ...view,
      component: 'vonMises',
      overlays: false,
      clipAxis: 0,
      clipFraction: 0.5,
    })
    expect(rendered.minimum).toBe(10)
    expect(rendered.maximum).toBe(10)
    const shear = { ...field, values: new Float64Array([0, 0, 0, 3, 0, 0]) }
    expect(createMeshFieldRenderData(shear, { ...view, component: 'magnitude' }).maximum).toBeCloseTo(Math.sqrt(18))
    expect(createMeshFieldRenderData(shear, { ...view, component: 'vonMises' }).maximum).toBeCloseTo(Math.sqrt(27))
    const triangles = rendered.geometries.filter((geometry) => geometry.primitive === 'triangles')
    const xs = triangles.flatMap((geometry) => [...geometry.positions].filter((_, index) => index % 3 === 0))
    expect(Math.max(...xs)).toBe(0.5)
    // The clipped tetrahedron is closed by a triangle lying on the section plane.
    expect(
      triangles.some((geometry) =>
        [...geometry.positions].some(
          (_, index, positions) =>
            index % 9 === 0 && positions[index] === 0.5 && positions[index + 3] === 0.5 && positions[index + 6] === 0.5,
        ),
      ),
    ).toBe(true)
  })

  it('keeps a pure moment load location visible without inventing a force arrow', () => {
    const input = fixture()
    const field = {
      ...parseRecordedMeshFields(input.rules, input.data).fields[0],
      supportNodes: new Uint32Array(),
      loadVectors: new Float64Array(3),
    }
    const rendered = createMeshFieldRenderData(field, { ...view, wireframe: false })
    const lines = rendered.geometries.filter((geometry) => geometry.primitive === 'lines')
    expect(lines).toHaveLength(1)
    expect(lines[0].indices).toHaveLength(6)
    for (let coordinate = 0; coordinate < 3; coordinate += 1) {
      const positions = lines[0].positions
      expect((positions[coordinate * 6 + coordinate] + positions[coordinate * 6 + 3 + coordinate]) / 2).toBeCloseTo(
        field.loadPoints[coordinate],
      )
    }
    expect(
      createMeshFieldRenderData(field, { ...view, wireframe: false, clipAxis: 0, clipFraction: 0.5 }).geometries.every(
        (geometry) => geometry.primitive === 'triangles',
      ),
    ).toBe(true)
  })

  it('rejects connectivity and value-location mismatches without silently drawing another domain', () => {
    const input = fixture()
    const invalid = {
      ...input.data,
      'field.domain.cells.tet4': createDataTensor({ dtype: 'int32' }, { value: [[0, 1, 2, 7]] }),
    }
    expect(parseRecordedMeshFields(input.rules, invalid).errors[0].message).toMatch(/absent node/)
    const mismatch = { ...input.data, 'field.values': createDataTensor({ dtype: 'int32' }, { value: [[1, 2, 3]] }) }
    expect(parseRecordedMeshFields(input.rules, mismatch).errors[0].message).toMatch(/do not match/)
    const badRegion = {
      ...input.data,
      'field.domain.metadata.cellRegions': createDataTensor({ dtype: 'int32' }, { value: [2] }),
    }
    expect(parseRecordedMeshFields(input.rules, badRegion).errors[0].message).toMatch(/absent region/)
    const badSupport = {
      ...input.data,
      'field.domain.metadata.supportNodes': createDataTensor({ dtype: 'int32' }, { value: [-1] }),
    }
    expect(parseRecordedMeshFields(input.rules, badSupport).errors[0].message).toMatch(/absent node/)
    const badLoad = {
      ...input.data,
      'field.domain.metadata.loadVectors': createDataTensor(
        { dtype: 'float64', quantityKind: 'Dimensionless', unit: '1' },
        { value: [[0, 1]] },
      ),
    }
    expect(parseRecordedMeshFields(input.rules, badLoad).errors[0].message).toMatch(/matching shapes/)
  })

  it('decodes attachment-backed records and chunks geometry beyond 65k vertices', () => {
    const input = fixture()
    const field = parseRecordedMeshFields(input.rules, input.data).fields[0]
    const count = 18_000
    const points = Array.from({ length: count * 4 }, (_, index) => [
      field.points[(index % 4) * 3] + Math.floor(index / 4) * 2,
      field.points[(index % 4) * 3 + 1],
      field.points[(index % 4) * 3 + 2],
    ])
    const rule = input.rules.find((rule) => rule.label === 'field.domain.points')!
    const attached = createAttachmentDataTensor(rule.result, { value: points }, 'mesh-test')
    attached.attachments.forEach(({ id, bytes }) => registerDataTensorAttachment(id, bytes))
    try {
      const cells = Array.from({ length: count }, (_, index) => [
        index * 4,
        index * 4 + 1,
        index * 4 + 2,
        index * 4 + 3,
      ])
      const data = {
        ...input.data,
        'field.domain.points': attached.tensor,
        'field.domain.cells.tet4': createDataTensor({ dtype: 'int32' }, { value: cells }),
        'field.values': createDataTensor(input.rules.find((rule) => rule.label === 'field.values')!.result, {
          value: points,
        }),
        'field.domain.metadata.cellRegions': createDataTensor({ dtype: 'int32' }, { value: Array(count).fill(0) }),
      }
      const parsed = parseRecordedMeshFields(input.rules, data)
      expect(parsed.errors).toEqual([])
      const rendered = createMeshFieldRenderData(parsed.fields[0], { ...view, overlays: false, wireframe: false })
      expect(rendered.geometries.length).toBeGreaterThan(1)
      expect(rendered.geometries.reduce((sum, geometry) => sum + geometry.indices.length, 0)).toBe(count * 12)
      rendered.geometries.forEach((geometry) => {
        expect(geometry.positions.length / 3).toBeLessThanOrEqual(65_535)
        expect(geometry.indices).toBeInstanceOf(Uint16Array)
        expect(geometry.indices.every((index) => index < geometry.positions.length / 3)).toBe(true)
      })
    } finally {
      releaseDataTensorAttachments(attached.attachments.map(({ id }) => id))
    }
  })

  it('removes shared interior faces and scales only displacement fields', () => {
    const input = fixture()
    const data = {
      ...input.data,
      'field.domain.points': createDataTensor(
        input.rules.find((rule) => rule.label === 'field.domain.points')!.result,
        {
          value: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ],
        },
      ),
      'field.domain.cells.tet4': createDataTensor(
        { dtype: 'int32' },
        {
          value: [
            [0, 1, 2, 3],
            [0, 2, 1, 4],
          ],
        },
      ),
      'field.values': createDataTensor(input.rules.find((rule) => rule.label === 'field.values')!.result, {
        value: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ],
      }),
      'field.domain.metadata.cellRegions': createDataTensor({ dtype: 'int32' }, { value: [0, 0] }),
    }
    const field = parseRecordedMeshFields(input.rules, data).fields[0]
    expect(field.boundaryFaces.length).toBe(18)
    const single = parseRecordedMeshFields(input.rules, input.data).fields[0]
    expect(createMeshFieldRenderData(single, { ...view, deformationScale: 2 }).bounds.max).toEqual([3, 3, 3])
    const other: RecordedMeshField = { ...single, quantity: 'mechanics.Force', valueUnit: 'N' }
    expect(createMeshFieldRenderData(other, { ...view, deformationScale: 2 }).bounds.max).toEqual([1, 1, 1])
  })
})
