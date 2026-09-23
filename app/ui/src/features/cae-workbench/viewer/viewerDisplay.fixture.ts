import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import modeling from '@jscad/modeling'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import type { DataSchema } from '@/lib/cad/model'
import type { MeasurementVisualizations } from '@/contracts/results'
import { calculationExampleInput } from '@/authoring/examples'
import { materialVarsHash } from '@/lib/material/resolution'
import type { WorkbenchViewerProps } from './WorkbenchViewer'

/** Small recorded fixtures: no Solver, API or database execution. */
export function stressViewerFixture(displacement = 0.1): WorkbenchViewerProps {
  const props = viewerDisplayFixture()
  const original = props.visualizations!.sample.field
  const field = {
    ...original,
    contract: {
      ...original.contract,
      visualization: { ...original.contract.visualization, nodeIdsPath: 'domain.metadata.nodeIds' },
    },
  }
  const nodeIdsSchema = { dtype: 'int32', axes: [{ length: 4 }] } as DataSchema
  const schema = { ...field.schema, 'domain.metadata.nodeIds': nodeIdsSchema } as Record<string, DataSchema>
  const data = {
    ...(field.data as Record<string, ReturnType<typeof createDataTensor>>),
    'domain.metadata.nodeIds': createDataTensor(nodeIdsSchema, { value: [0, 1, 2, 3] }),
  }
  const stressSchema = {
    ...schema,
    values: { ...schema.values, axes: [{ length: 1 }, { length: 6 }] },
  }
  return {
    ...props,
    initialDefaults: {
      version: 2,
      geometryMode: 0.9,
      selectedOutput: '',
      visualizations: { 'mesh-field': '@visualizations.sample.stress', polyline: '' },
      settings: {},
      camera: null,
    },
    visualizations: {
      sample: {
        stress: {
          ...field,
          contract: { ...field.contract, visualization: { ...field.contract.visualization, valueKind: 'stress' } },
          schema: stressSchema,
          data: {
            ...data,
            location: createDataTensor(schema.location, { value: 'cell' }),
            quantity: createDataTensor(schema.quantity, { value: 'mechanics.Stress' }),
            valueUnit: createDataTensor(schema.valueUnit, { value: 'Pa' }),
            values: createDataTensor(stressSchema.values, { value: [[10, 0, 0, 0, 0, 0]] }),
          },
        },
        field: {
          ...field,
          schema,
          data: {
            ...data,
            values: createDataTensor(schema.values, {
              value: [
                [0, 0, 0],
                [displacement, 0, 0],
                [0, displacement, 0],
                [0, 0, displacement],
              ],
            }),
          },
        },
      },
    },
  }
}

export function viewerDisplayFixture(): WorkbenchViewerProps {
  const provenance = {
    task: 'sample',
    solver: { name: 'fixture', version: '1' },
    stateRevision: 1,
    invocation: 1,
    catalogRevision: 'fixture',
  }
  const schema: Record<string, DataSchema> = {}
  const field: Record<string, ReturnType<typeof createDataTensor>> = {}
  const entries: [string, unknown][] = [
    ['domain.kind', 'unstructured-mesh'],
    ['domain.identity', 'tetrahedron'],
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
    ['domain.metadata.regionIds', ['body']],
    ['domain.metadata.supportNodes', [0]],
    ['domain.metadata.loadPoints', [[1, 0, 0]]],
    ['domain.metadata.loadVectors', [[0, 1, 0]]],
    ['location', 'node'],
    ['quantity', 'kinematics.Displacement'],
    ['valueUnit', 'm'],
    [
      'values',
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0, 0.1, 0],
        [0, 0, 0.1],
      ],
    ],
  ]
  for (const [member, value] of entries) {
    const shape = Array.isArray(value) ? [value.length, ...(Array.isArray(value[0]) ? [value[0].length] : [])] : []
    schema[member] = {
      dtype:
        typeof value === 'string' || member.endsWith('regionIds')
          ? 'string'
          : member.includes('cells') || member.endsWith('cellRegions') || member.endsWith('supportNodes')
            ? 'int32'
            : 'float64',
      axes: shape.map((length) => ({ length })),
    } as DataSchema
    field[member] = createDataTensor(schema[member], {
      value: value as Parameters<typeof createDataTensor>[1]['value'],
    })
  }
  const raySchema: Record<string, DataSchema> = {
    positions: { dtype: 'float64', quantityKind: 'Length', unit: 'm', axes: [{ length: 3 }, { length: 3 }] },
    offsets: { dtype: 'uint32', axes: [{ length: 2 }] },
  }
  const visualizations: MeasurementVisualizations = {
    sample: {
      field: {
        contract: {
          artifactType: 'fixture@1',
          visualization: { kind: 'mesh-field', coordinateSpace: 'experiment', valueKind: 'displacement' },
        },
        schema,
        data: field,
        provenance,
      },
      rays: {
        contract: {
          artifactType: 'fixture@1',
          visualization: { kind: 'polyline', coordinateSpace: 'experiment', vertices: 'positions', offsets: 'offsets' },
        },
        schema: raySchema,
        data: {
          positions: createDataTensor(raySchema.positions, {
            value: [
              [-1, 0, 0],
              [0, 0.5, 0.5],
              [2, 1, 1],
            ],
          }),
          offsets: createDataTensor(raySchema.offsets, { value: [0, 3] }),
        },
        provenance,
      },
    },
  }
  const source = calculationExampleInput.signal
  const gridSchema: DataSchema = {
    dtype: source.dtype,
    quantityKind: source.quantityKind,
    unit: source.unit,
    axes: source.axes.map((axis, index) => ({ name: axis.name, length: source.shape[index] })),
    boxGrid: source.boxGrid,
  } as DataSchema
  const tensor = {
    ...createDataTensor(gridSchema, { value: varsTensorFromFlat([...source.data], source.shape) }),
    axes: source.axes.map(({ ticks }) => ({ ticks })),
    boxGrid: source.boxGrid,
    provenance,
  }
  const scene = {
    lengthUnit: 'm',
    parts: [
      {
        id: 'body',
        rootId: 'body',
        geometry: modeling.primitives.cuboid({ size: [1.5, 1.5, 1.5], center: [0.5, 0.5, 0.5] }),
        color: [0.65, 0.7, 0.75, 1],
      },
    ],
    tree: [{ id: 'body', label: 'Body', kind: 'geometry', children: [] }],
  }
  const noop = () => {}
  return {
    experiment: {
      kind: 'experiment',
      sourceBundle: { files: { 'simulate.py': 'fixture' } },
    } as WorkbenchViewerProps['experiment'],
    experimentDocument: {
      scene,
      sceneHash: 'fixture',
      evaluatedSnapshot: { sourceHash: 'fixture', variables: {} },
      handleRenderStart: noop,
      handleRenderEnd: noop,
      handleRenderError: noop,
    } as unknown as WorkbenchViewerProps['experimentDocument'],
    resultSourceHash: 'fixture',
    resultVarsHash: materialVarsHash({}),
    resultContracts: {
      signal: {
        ...provenance,
        output: 'signal',
        artifactType: 'fixture@1',
        schema: gridSchema,
        visualization: { kind: 'box-grid' },
      },
      summary: {
        ...provenance,
        output: 'summary',
        artifactType: 'fixture@1',
        schema: gridSchema,
        visualization: { kind: 'tensor' },
      },
    },
    recordedRules: ['signal', 'summary'].map((label) => ({
      label,
      result: gridSchema,
      methodId: 'stored',
      target: [],
      parameters: {},
    })),
    recordedData: { signal: tensor, summary: tensor },
    visualizations,
    autoSelectResult: true,
    onFindSelectionSource: noop,
    onSelectionSourcePathsChange: noop,
    selectionSourceStatus: {},
  }
}
