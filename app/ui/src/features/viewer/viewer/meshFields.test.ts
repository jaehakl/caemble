import type { RecordedResultContracts } from '@/contracts/results'
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
import { meshHarmonicAtPhase } from './meshDeformation'
import { resultVisualizationSchema } from '@/contracts/resultValidators'
import { projectArtifactRecordingSchema } from '@/lib/cad/simulation/outputRecording'
import type { KernelArtifactDataSpec } from '@/contracts/solver'

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
  const contracts: RecordedResultContracts = {
    field: {
      task: 'solver',
      output: 'field',
      solver: { name: 'fixture', version: '1.0.0' },
      artifactType: 'fixture@1',
      catalogRevision: 'fixture',
      schema: {},
      visualization: {
        kind: 'mesh-field',
        coordinateSpace: 'experiment',
        valueKind: stress ? 'stress' : 'displacement',
      },
    },
  }
  return { rules, data: data as RecordedData, contracts }
}

describe('recorded mesh fields', () => {
  it.each([false, true])('renders an explicitly recorded tri3 traction snapshot, empty=%s', (empty) => {
    const declaration: KernelArtifactDataSpec = {
      dtype: 'float64',
      quantityKind: 'Pressure',
      unit: 'Pa',
      axes: [
        { name: 'cell' },
        { name: 'time', length: 1, unit: 's', quantityKind: 'Time' },
        { name: 'component', length: 3 },
      ],
      recording: 'mesh-field',
      mesh: { version: 1, cellType: 'tri3' },
      metadata: {
        pressureOffset: { dtype: 'float64', quantityKind: 'Pressure', unit: 'Pa' },
        normalConvention: { dtype: 'string' },
      },
      visualization: resultVisualizationSchema.parse({
        kind: 'mesh-field',
        valueKind: 'vector',
        components: ['x', 'y', 'z'],
      }),
    }
    const schema = projectArtifactRecordingSchema(declaration, 'm')
    expect(schema).toHaveProperty('domain.cells.tri3')
    expect(schema).not.toHaveProperty('domain.cells.tet4')
    expect(schema).not.toHaveProperty('domain.metadata.quality')
    expect(schema).not.toHaveProperty('values.metadata')
    const values: Record<string, unknown> = {
      'domain.kind': 'unstructured-mesh',
      'domain.identity': 'surface',
      'domain.lengthUnit': 'm',
      'domain.points': empty
        ? []
        : [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
      'domain.cells.tri3': empty ? [] : [[0, 1, 2]],
      'domain.metadata.sourceModelIdentity': 'original-volume',
      'domain.metadata.sourceMeshNodeIds': empty ? [] : [3, 9, 12],
      'domain.metadata.boundaryProvenance.offsets': empty ? [0] : [0, 1],
      'domain.metadata.boundaryProvenance.sources': empty ? [] : ['experiment'],
      'domain.metadata.boundaryProvenance.rootIds': empty ? [] : ['fluid'],
      'domain.metadata.boundaryProvenance.sourceNodeIds': empty ? [] : ['wall'],
      'domain.metadata.boundaryProvenance.surfaceIndices': empty ? [] : [2],
      location: 'cell',
      quantity: 'Pressure',
      valueUnit: 'Pa',
      values: empty ? [] : [[[3, 4, 0]]],
      'metadata.pressureOffset': -12,
      'metadata.normalConvention': 'outward-fluid',
    }
    const rules: RecordedDataRule[] = [],
      data: Record<string, unknown> = {}
    const add = (node: unknown, prefix: string) => {
      if (!node || typeof node !== 'object') throw new Error('Invalid fixture schema')
      if (!('dtype' in node)) {
        for (const [name, child] of Object.entries(node)) add(child, prefix ? `${prefix}.${name}` : name)
        return
      }
      const result = node as DataSchema,
        label = `traction.${prefix}`
      rules.push({ label, result, methodId: 'fixture', target: [], parameters: {} })
      const actual = values[prefix] as Parameters<typeof createDataTensor>[1]['value']
      const shape =
        prefix === 'domain.points'
          ? [empty ? 0 : 3, 3]
          : prefix === 'domain.cells.tri3'
            ? [empty ? 0 : 1, 3]
            : prefix === 'values'
              ? [empty ? 0 : 1, 1, 3]
              : Array.isArray(actual)
                ? [actual.length]
                : []
      data[label] = {
        shape,
        axes: result.axes?.map((axis) => (axis.name === 'time' ? { ticks: [0.0375] } : { implicitOrdinal: true })),
        storage: { kind: 'inline', value: actual },
      }
    }
    add(schema, '')
    const contracts: RecordedResultContracts = {
      traction: {
        task: 'fluid',
        output: 'traction',
        solver: { name: 'fixture', version: '1' },
        artifactType: 'fixture/traction@1',
        catalogRevision: 'fixture',
        schema,
        visualization: declaration.visualization!,
      },
    }
    const parsed = parseRecordedMeshFields(rules, data as RecordedData, contracts)
    expect(parsed.errors).toEqual([])
    const field = parsed.fields[0]
    expect(field.cellType).toBe('tri3')
    expect(field.snapshotTime).toBe(0.0375)
    expect(field.metadata).toEqual({ pressureOffset: -12, normalConvention: 'outward-fluid' })
    expect(field.boundaryCells.length).toBe(empty ? 0 : 1)
    const rendered = createMeshFieldRenderData(field, {
      ...view,
      wireframe: false,
      overlays: false,
      clipAxis: 0,
      clipFraction: 0.5,
    })
    expect(rendered.geometries.length).toBe(empty ? 0 : 1)
    expect(rendered.bounds.min.every(Number.isFinite)).toBe(true)
    if (!empty) {
      expect(rendered.maximum).toBe(5)
      // One clipped triangle becomes a quadrilateral; no volume cap is synthesized.
      expect(rendered.geometries[0].indices.length).toBe(6)
      expect(Array.from(rendered.geometries[0].positions).filter((_, index) => index % 3 === 2)).toEqual([
        0, 0, 0, 0, 0, 0,
      ])
    }
  })
  it.each(['pressure', 'velocity'] as const)('restores a %s cell snapshot with its singleton time axis', (kind) => {
    const input = fixture(true)
    const vector = kind === 'velocity'
    const schema = {
      dtype: 'float64',
      quantityKind: vector ? 'kinematics.Velocity' : 'Pressure',
      unit: vector ? 'm.s-1' : 'Pa',
      tensorOrder: 0,
      axes: [
        { name: 'cell', length: 1 },
        { name: 'time', unit: 's', quantityKind: 'Time', length: 1 },
        ...(vector ? [{ name: 'component', length: 3 }] : []),
      ],
    } as DataSchema
    const value = vector ? [[[1, -2, 3]]] : [[-4]]
    const axes = [
      { implicitOrdinal: true as const },
      { name: 'time', unit: 's', ticks: [0.0375] },
      ...(vector ? [{ implicitOrdinal: true as const }] : []),
    ]
    const tensor = createDataTensor(schema, { value, axes })
    const rules = input.rules.map((rule) => (rule.label === 'field.values' ? { ...rule, result: schema } : rule))
    const data = {
      ...input.data,
      'field.values': tensor,
      'field.quantity': createDataTensor({ dtype: 'string' }, { value: schema.quantityKind! }),
      'field.valueUnit': createDataTensor({ dtype: 'string' }, { value: schema.unit! }),
    }
    const contracts: RecordedResultContracts = {
      field: {
        ...input.contracts.field,
        visualization: {
          kind: 'mesh-field',
          coordinateSpace: 'experiment',
          sampling: 'cell-average',
          configuration: 'current',
          ...(vector ? { components: ['x', 'y', 'z'] } : { valueKind: 'scalar' }),
        },
      },
    }
    expect(tensor.axes?.[1]).toEqual(axes[1])
    const parsed = parseRecordedMeshFields(rules, data, contracts)
    expect(parsed.errors).toEqual([])
    expect(parsed.fields[0].componentCount).toBe(vector ? 3 : 1)
    expect(parsed.fields[0].values).toEqual(new Float64Array(vector ? [1, -2, 3] : [-4]))
    expect(parsed.fields[0].times).toBeUndefined()
    const rendered = createMeshFieldRenderData(parsed.fields[0], { ...view, overlays: false })
    expect(rendered.maximum).toBe(vector ? Math.sqrt(14) : -4)
  })
  it('retains cell averaging and the compression-positive convention on reread', () => {
    const input = fixture(true)
    const semantic = resultVisualizationSchema.parse({
      ...input.contracts.field.visualization,
      configuration: 'reference',
      sampling: 'cell-average',
      weighting: 'reference-volume',
      signConvention: 'compression-positive',
    })
    const contracts = { field: { ...input.contracts.field, visualization: semantic } }
    const result = parseRecordedMeshFields(input.rules, input.data, contracts)
    expect(result.errors).toEqual([])
    expect(result.fields[0]).toMatchObject({
      configuration: 'reference',
      sampling: 'cell-average',
      weighting: 'reference-volume',
      signConvention: 'compression-positive',
    })
  })
  it.each([
    ['displacement', 3, 4, 2],
    ['stress', 6, 1, 2],
    ['pressure', 1, 4, 2],
    ['displacement', 3, 4, 3000],
    ['stress', 6, 1, 3000],
    ['pressure', 1, 4, 3000],
  ] as const)(
    'restores a complete %s phasor sweep with %i components (%i entities, %i frequencies)',
    (kind, components, count, samples) => {
      const input = fixture(kind === 'stress')
      const rules = input.rules
        .filter((rule) => rule.label !== 'field.values')
        .map((rule) => ({ ...rule, label: rule.label.replace('field.', 'field.field.') }))
      const data = Object.fromEntries(
        Object.entries(input.data).map(([key, value]) => [key.replace('field.', 'field.field.'), value]),
      ) as Record<string, unknown>
      const frequencies = Array.from({ length: samples }, (_, i) => (i === 0 ? 91 : i === 1 ? 37 : 100 + i))
      const unit = kind === 'displacement' ? 'm' : 'Pa'
      const schema = {
        dtype: 'complex64',
        quantityKind: kind === 'displacement' ? 'kinematics.Displacement' : 'Pressure',
        unit,
        tensorOrder: 0,
        axes: [
          { length: count },
          { length: samples, name: 'frequency', quantityKind: 'Frequency', unit: 'Hz' },
          { length: components },
        ],
      } as DataSchema
      const values = Array.from({ length: count }, (_, entity) =>
        frequencies.map((_, sample) =>
          Array.from({ length: components }, (_, component) => ({
            re: entity * 100 + sample * 10 + component + 1,
            im: 2 * (entity * 100 + sample * 10 + component + 1),
          })),
        ),
      )
      const attached = createAttachmentDataTensor(
        schema,
        { value: values, axes: [{ implicitOrdinal: true }, { ticks: frequencies }, { implicitOrdinal: true }] },
        'harmonic-mesh-test',
      )
      attached.attachments.forEach(({ id, bytes }) => registerDataTensorAttachment(id, bytes))
      const frequencySchema = {
        dtype: 'float64',
        unit: 'Hz',
        quantityKind: 'Frequency',
        tensorOrder: 0,
        axes: [{ length: samples }],
      } as DataSchema
      rules.push(
        { label: 'field.field.values', methodId: 'test', target: [], parameters: {}, result: schema },
        { label: 'field.frequencies', methodId: 'test', target: [], parameters: {}, result: frequencySchema },
      )
      data['field.field.values'] = attached.tensor
      data['field.field.valueUnit'] = createDataTensor({ dtype: 'string' }, { value: unit })
      data['field.frequencies'] = createDataTensor(frequencySchema, { value: frequencies })
      const contracts: RecordedResultContracts = {
        field: {
          ...input.contracts.field,
          visualization: {
            kind: 'mesh-field',
            coordinateSpace: 'experiment',
            fieldPath: 'field',
            ...(kind === 'pressure' ? {} : { valueKind: kind }),
            frequency: { path: 'frequencies', axis: 1, entityAxis: 0, componentAxis: 2 },
            phasor: { timeConvention: 'exp(+i*omega*t)', amplitude: 'peak' },
          },
        },
      }
      try {
        expect(attached.attachments.length > 0).toBe(samples === 3000)
        const parsed = parseRecordedMeshFields(rules, data as RecordedData, contracts)
        expect(parsed.errors).toEqual([])
        const field = parsed.fields[0]
        expect(field.componentCount).toBe(components)
        expect(field.spectrum?.frequencies.slice(0, 2)).toEqual(new Float64Array([91, 37]))
        expect(field.values[count * components]).toBe(11)
        if (count > 1) expect(field.values[components]).toBe(101)
        expect(meshHarmonicAtPhase(field, 37, 90).values[0]).toBeCloseTo(-22)
        expect(() => createMeshFieldRenderData(field, view)).toThrow('Select a frequency and phase')
        const mismatch = {
          ...data,
          'field.frequencies': createDataTensor(frequencySchema, {
            value: frequencies.map((frequency) => frequency + 1),
          }),
        }
        expect(parseRecordedMeshFields(rules, mismatch as RecordedData, contracts).errors[0].message).toContain(
          'coordinates differ',
        )
      } finally {
        releaseDataTensorAttachments(attached.attachments.map(({ id }) => id))
      }
    },
  )
  it('rejects unsupported and ambiguous harmonic display semantics', () => {
    const value = {
      kind: 'mesh-field',
      frequency: { path: 'frequencies', axis: 1, entityAxis: 0, componentAxis: 2 },
      phasor: { timeConvention: 'exp(+i*omega*t)', amplitude: 'peak' },
    }
    expect(resultVisualizationSchema.safeParse(value).success).toBe(true)
    expect(resultVisualizationSchema.safeParse({ ...value, phasor: undefined }).success).toBe(false)
    expect(
      resultVisualizationSchema.safeParse({ ...value, phasor: { ...value.phasor, amplitude: 'rms' } }).success,
    ).toBe(false)
    expect(
      resultVisualizationSchema.safeParse({ ...value, time: { path: 'times', axis: 0, nodeAxis: 1, componentAxis: 2 } })
        .success,
    ).toBe(false)
  })
  it('restores a domain-bound time history from frozen member and axis semantics', () => {
    const input = fixture()
    const rules = input.rules.map((rule) => ({ ...rule, label: rule.label.replace('field.', 'field.field.') }))
    const data = Object.fromEntries(
      Object.entries(input.data).map(([name, value]) => [name.replace('field.', 'field.field.'), value]),
    ) as Record<string, unknown>
    const history = [Array.from({ length: 4 }, () => [0, 0, 0]), Array.from({ length: 4 }, () => [0.001, 0, 0])]
    for (const [label, value, shape, unit] of [
      ['field.times', [0, 0.01], [2], 's'],
      ['field.values', history, [2, 4, 3], 'm'],
      ['field.field.domain.metadata.nodeIds', [10, 20, 30, 40], [4], undefined],
    ] as const) {
      const schema = {
        ...(unit
          ? { dtype: 'float64', unit, quantityKind: unit === 's' ? 'Time' : 'Length', tensorOrder: 0 }
          : { dtype: 'int32' }),
        axes: shape.map((length) => ({ length })),
      } as DataSchema
      rules.push({ label, methodId: 'test', target: [], parameters: {}, result: schema })
      data[label] = createDataTensor(schema, {
        value,
        ...(label === 'field.values'
          ? { axes: [{ ticks: [0, 0.01] }, { ticks: [10, 20, 30, 40] }, { implicitOrdinal: true as const }] }
          : {}),
      })
    }
    const contracts: RecordedResultContracts = {
      field: {
        ...input.contracts.field,
        visualization: {
          ...input.contracts.field.visualization,
          fieldPath: 'field',
          valuePath: 'values',
          nodeIdsPath: 'field.domain.metadata.nodeIds',
          time: { path: 'times', axis: 0, nodeAxis: 1, componentAxis: 2 },
        },
      },
    }
    const parsed = parseRecordedMeshFields(rules, data as RecordedData, contracts)
    expect(parsed.errors).toEqual([])
    expect(parsed.fields[0].times).toEqual(new Float64Array([0, 0.01]))
    expect(parsed.fields[0].historyValues?.slice(12, 15)).toEqual(new Float64Array([0.001, 0, 0]))
    expect(parsed.fields[0].nodeIds).toEqual(new Int32Array([10, 20, 30, 40]))
  })
  it('restores mesh identity, values, semantic metadata and exterior faces', () => {
    const input = fixture()
    const result = parseRecordedMeshFields(input.rules, input.data, input.contracts)
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
    const empty = parseRecordedMeshFields(input.rules, emptyOverlays, input.contracts)
    expect(empty.errors).toEqual([])
    expect(empty.fields[0].loadPoints).toHaveLength(0)
    expect(createMeshFieldRenderData(empty.fields[0], view).geometries).toHaveLength(2)
  })

  it('uses cell stress values, von Mises and interpolated section caps', () => {
    const input = fixture(true)
    const field = parseRecordedMeshFields(input.rules, input.data, input.contracts).fields[0]
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
      ...parseRecordedMeshFields(input.rules, input.data, input.contracts).fields[0],
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
    expect(parseRecordedMeshFields(input.rules, invalid, input.contracts).errors[0].message).toMatch(/absent node/)
    const mismatch = { ...input.data, 'field.values': createDataTensor({ dtype: 'int32' }, { value: [[1, 2, 3]] }) }
    expect(parseRecordedMeshFields(input.rules, mismatch, input.contracts).errors[0].message).toMatch(/do not match/)
    const badRegion = {
      ...input.data,
      'field.domain.metadata.cellRegions': createDataTensor({ dtype: 'int32' }, { value: [2] }),
    }
    expect(parseRecordedMeshFields(input.rules, badRegion, input.contracts).errors[0].message).toMatch(/absent region/)
    const badSupport = {
      ...input.data,
      'field.domain.metadata.supportNodes': createDataTensor({ dtype: 'int32' }, { value: [-1] }),
    }
    expect(parseRecordedMeshFields(input.rules, badSupport, input.contracts).errors[0].message).toMatch(/absent node/)
    const badLoad = {
      ...input.data,
      'field.domain.metadata.loadVectors': createDataTensor(
        { dtype: 'float64', quantityKind: 'Dimensionless', unit: '1' },
        { value: [[0, 1]] },
      ),
    }
    expect(parseRecordedMeshFields(input.rules, badLoad, input.contracts).errors[0].message).toMatch(/matching shapes/)
  })

  it('decodes attachment-backed records and chunks geometry beyond 65k vertices', () => {
    const input = fixture()
    const field = parseRecordedMeshFields(input.rules, input.data, input.contracts).fields[0]
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
      const parsed = parseRecordedMeshFields(input.rules, data, input.contracts)
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
    const field = parseRecordedMeshFields(input.rules, data, input.contracts).fields[0]
    expect(field.boundaryFaces.length).toBe(18)
    const single = parseRecordedMeshFields(input.rules, input.data, input.contracts).fields[0]
    expect(createMeshFieldRenderData(single, { ...view, deformationScale: 2 }).bounds.max).toEqual([3, 3, 3])
    const other: RecordedMeshField = { ...single, quantity: 'mechanics.Force', valueUnit: 'N', valueKind: undefined }
    expect(createMeshFieldRenderData(other, { ...view, deformationScale: 2 }).bounds.max).toEqual([1, 1, 1])
  })
})
