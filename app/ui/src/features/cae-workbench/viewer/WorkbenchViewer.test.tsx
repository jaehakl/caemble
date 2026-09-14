import { materialVarsHash } from '@/lib/material/resolution'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkbenchViewer, type WorkbenchViewerProps } from './WorkbenchViewer'
import type { DataTensor } from '@/lib/cad/model'
import { calculationExampleInput } from '@/authoring/examples'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'

vi.mock('@/features/viewer/viewer/BoxGridResult', () => ({
  BoxGridResult: ({ name }: { name: string }) => <div>Box Grid {name}</div>,
}))

vi.mock('@/features/viewer/viewer/CadViewer', () => ({ default: () => <div>Geometry preview</div> }))
vi.mock('@/features/viewer/viewer/MeshFieldResult', () => ({
  MeshFieldResult: ({ displacementFields }: { displacementFields: { label: string }[] }) => (
    <div data-testid="stored-volume" data-displacements={displacementFields.map((field) => field.label).join(',')}>
      Stored volume field
    </div>
  ),
}))
vi.mock('@/features/viewer/viewer/MeshTransformResult', () => ({
  MeshTransformResult: ({ motion }: { motion: { label: string } }) => <div>Rigid animation {motion.label}</div>,
}))
vi.mock('@/features/viewer/viewer/meshTransforms', () => ({
  parseRecordedMeshTransforms: (
    _rules: unknown,
    _data: unknown,
    contracts: Record<string, { visualization: { kind: string } }>,
  ) => ({
    motions: Object.entries(contracts)
      .filter(([, value]) => value.visualization.kind === 'mesh-transform')
      .map(([label]) => ({ label, identity: 'rigid-mesh', lengthUnit: 'm' })),
    errors: [],
  }),
}))
vi.mock('@/features/viewer/viewer/resultPolylines', () => ({
  parseResultPolylines: (contracts: Record<string, { visualization: { kind: string } }>) => ({
    bundles: Object.entries(contracts)
      .filter(([, value]) => value.visualization.kind === 'polyline')
      .map(([id]) => ({ id })),
    errors: [],
  }),
}))
vi.mock('@/features/viewer/viewer/meshFields', () => ({
  parseRecordedMeshFields: (
    _rules: unknown,
    _data: unknown,
    contracts: Record<string, { visualization: { kind: string } }>,
  ) => ({
    fields: Object.entries(contracts)
      .filter(([, value]) => value.visualization.kind === 'mesh-field')
      .map(([label]) => ({ label, identity: 'mesh' })),
    errors: [],
    labels: ['displacement'],
  }),
}))

function gridSelectionProps(grids: Record<string, readonly [number, number, number]>) {
  const recordedData: Record<string, DataTensor> = {}
  const resultContracts: Record<string, NonNullable<WorkbenchViewerProps['resultContracts']>[string]> = {}
  for (const [name, gridShape] of Object.entries(grids)) {
    const shape = [...gridShape, 1, 1, 1, 1]
    recordedData[name] = {
      shape,
      boxGrid: { ...calculationExampleInput.signal.boxGrid, gridShape },
      storage: { kind: 'inline', value: varsTensorFromFlat(Array(shape.reduce((a, b) => a * b, 1)).fill(0), shape) },
    }
    resultContracts[name] = {
      task: 'wave',
      output: name,
      solver: { name: 'fixture', version: '1' },
      artifactType: 'fixture@1',
      catalogRevision: 'frozen',
      schema: {},
      visualization: { kind: 'box-grid' },
    }
  }
  return {
    experiment: null,
    experimentDocument: {} as Parameters<typeof WorkbenchViewer>[0]['experimentDocument'],
    onFindSelectionSource: vi.fn(),
    onSelectionQueryChange: vi.fn(),
    onSelectionSourcePathsChange: vi.fn(),
    selectionQuery: null,
    selectionSourceStatus: {},
    viewerExpanded: false,
    autoSelectResult: true,
    recordedData,
    resultContracts,
  }
}

it('selects a native rigid animation beside numerical Outputs through its semantic contract', () => {
  const props = gridSelectionProps({ density: [2, 2, 1] })
  render(
    <WorkbenchViewer
      {...props}
      visualizations={{
        movement: {
          pose: {
            contract: {
              artifactType: 'fixture/poses@1',
              visualization: { kind: 'mesh-transform', coordinateSpace: 'experiment' },
            },
            schema: { times: { dtype: 'float64', axes: [{ name: 'time' }] } },
            data: { times: { shape: [2], axes: [{ ticks: [0, 1] }], storage: { kind: 'inline', value: [0, 1] } } },
            provenance: {
              task: 'movement',
              solver: { name: 'fixture', version: '1' },
              stateRevision: 1,
              invocation: 1,
              catalogRevision: 'frozen',
            },
          },
        },
      }}
    />,
  )
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('density')
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: '@visualizations.movement.pose' } })
  expect(screen.getByText('Rigid animation @visualizations.movement.pose')).toBeTruthy()
  expect(screen.queryByText(/Geometry가 준비되지 않았습니다/)).toBeNull()
  expect(screen.queryByText('Box Grid density')).toBeNull()
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'density' } })
  expect(screen.getByText('Box Grid density')).toBeTruthy()
})

it('prefers spatial grid count over tensor size, physical volume and non-grid outputs without Geometry', () => {
  const props = gridSelectionProps({ small: [2, 2, 1], largest: [3, 3, 1] })
  const small = props.recordedData.small
  const shape = [2, 2, 1, 10, 10, 1, 1]
  props.recordedData.small = {
    ...small,
    shape,
    boxGrid: { ...small.boxGrid!, size: [100, 100, 100] },
    storage: { kind: 'inline', value: varsTensorFromFlat(Array(400).fill(0), shape) },
  }
  props.resultContracts.mesh = { ...props.resultContracts.small, visualization: { kind: 'mesh-field' } }
  render(<WorkbenchViewer {...props} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('largest')
})

it('breaks equal grid counts by existing output order', () => {
  render(<WorkbenchViewer {...gridSelectionProps({ first: [2, 3, 1], second: [3, 1, 2] })} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('first')
})

it('excludes errors, missing data and invalid grid dimensions from the preference', () => {
  const props = gridSelectionProps({ valid: [2, 2, 1], failed: [4, 4, 4], missing: [5, 5, 5], invalid: [3, 3, 3] })
  delete props.recordedData.missing
  const invalid = props.recordedData.invalid
  props.recordedData.invalid = { ...invalid, boxGrid: { ...invalid.boxGrid!, gridShape: [3, 0, 3] } }
  render(<WorkbenchViewer {...props} resultErrors={{ failed: 'Failed' }} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('valid')
})

it('waits for loading to finish and keeps the chosen result through later updates and manual selection', () => {
  const props = gridSelectionProps({ small: [1, 1, 1], large: [3, 3, 3] })
  const view = render(<WorkbenchViewer {...props} recordedData={{ small: props.recordedData.small }} loading />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('')
  view.rerender(<WorkbenchViewer {...props} loading />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('')
  view.rerender(<WorkbenchViewer {...props} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('large')
  const newer = gridSelectionProps({ small: [5, 5, 5], large: [3, 3, 3] })
  view.rerender(<WorkbenchViewer {...newer} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('large')
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'small' } })
  view.rerender(<WorkbenchViewer {...props} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('small')
})

it('preserves external selection and manual choices made during loading', () => {
  const props = gridSelectionProps({ small: [1, 1, 1], large: [3, 3, 3] })
  const view = render(<WorkbenchViewer {...props} selectedResult="small" />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('small')
  view.unmount()
  const manual = render(<WorkbenchViewer {...props} loading />)
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'small' } })
  manual.rerender(<WorkbenchViewer {...props} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('small')
})

it('shows stored mesh results centrally, permits Geometry review, and displays download progress', () => {
  render(
    <WorkbenchViewer
      resultContracts={{
        displacement: {
          task: 'solid',
          output: 'motion',
          solver: { name: 'fixture', version: '1.0.0' },
          artifactType: 'fixture@1',
          catalogRevision: 'frozen',
          schema: {},
          visualization: { kind: 'mesh-field', coordinateSpace: 'experiment' },
        },
      }}
      experiment={null}
      experimentDocument={{} as Parameters<typeof WorkbenchViewer>[0]['experimentDocument']}
      onFindSelectionSource={vi.fn()}
      onSelectionQueryChange={vi.fn()}
      onSelectionSourcePathsChange={vi.fn()}
      onToggleViewerExpanded={vi.fn()}
      selectionQuery={null}
      selectionSourceStatus={{}}
      viewerExpanded={false}
      loading
      downloadProgress={{ completed: 4, total: 40 }}
    />,
  )
  expect(screen.getByText('Geometry preview')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'displacement' } })
  expect(screen.getByText('Stored volume field')).toBeTruthy()
  expect(screen.getByText(/4\/40/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: '' } })
  expect(screen.getByText('Geometry preview')).toBeTruthy()
  expect(screen.queryByText('Stored volume field')).toBeNull()
})

it('offers deformation fields only from the selected native result invocation', () => {
  const provenance = {
    task: 'solid',
    solver: { name: 'fixture', version: '1' },
    stateRevision: 2,
    invocation: 3,
    catalogRevision: 'frozen',
  }
  const schema = { dtype: 'float64', axes: [{ name: 'entity' }] }
  const visual = {
    contract: {
      artifactType: 'fixture/field@1',
      visualization: { kind: 'mesh-field' as const, coordinateSpace: 'experiment' as const },
    },
    schema,
    data: { shape: [1], axes: [{ implicitOrdinal: true as const }], storage: { kind: 'inline' as const, value: [1] } },
    provenance,
  }
  render(
    <WorkbenchViewer
      experiment={null}
      experimentDocument={{} as Parameters<typeof WorkbenchViewer>[0]['experimentDocument']}
      onFindSelectionSource={vi.fn()}
      onSelectionQueryChange={vi.fn()}
      onSelectionSourcePathsChange={vi.fn()}
      selectionQuery={null}
      selectionSourceStatus={{}}
      viewerExpanded={false}
      selectedResult="@visualizations.solid.stress"
      visualizations={{
        solid: {
          stress: visual,
          displacement: visual,
          old: { ...visual, provenance: { ...provenance, invocation: 2 } },
        },
      }}
    />,
  )
  expect(screen.getByTestId('stored-volume')).toHaveAttribute(
    'data-displacements',
    '@visualizations.solid.stress,@visualizations.solid.displacement',
  )
})

it('keeps automatic visuals selectable and prevents overlays from a different invocation', () => {
  const provenance = {
    task: 'ray',
    solver: { name: 'fixture', version: '1' },
    stateRevision: 2,
    invocation: 3,
    catalogRevision: 'frozen',
  }
  const schema = { dtype: 'float64', tensorOrder: 0, axes: [{ name: 'sample' }] }
  const tensor = { shape: [1], axes: [{ ticks: [0] }], storage: { kind: 'inline' as const, value: [1] }, provenance }
  const props: Parameters<typeof WorkbenchViewer>[0] = {
    experiment: null,
    experimentDocument: { scene: {}, evaluatedSnapshot: { sourceHash: 'source', variables: {} } } as Parameters<
      typeof WorkbenchViewer
    >[0]['experimentDocument'],
    onFindSelectionSource: vi.fn(),
    onSelectionQueryChange: vi.fn(),
    onSelectionSourcePathsChange: vi.fn(),
    onToggleViewerExpanded: vi.fn(),
    selectionQuery: null,
    selectionSourceStatus: {},
    viewerExpanded: false,
    resultSourceHash: 'source',
    resultVarsHash: materialVarsHash({}),
    recordedData: { flux: tensor },
    resultContracts: {
      flux: {
        task: 'ray',
        output: 'flux',
        solver: provenance.solver,
        catalogRevision: 'frozen',
        artifactType: 'fixture@1',
        schema,
        visualization: { kind: 'box-grid' },
      },
    },
    visualizations: {
      ray: {
        paths: {
          contract: {
            artifactType: 'fixture/paths@1',
            visualization: { kind: 'polyline', coordinateSpace: 'experiment' },
          },
          schema,
          data: tensor,
          provenance: { ...provenance, invocation: 4 },
        },
      },
    },
  }
  const { rerender } = render(<WorkbenchViewer {...props} />)
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'flux' } })
  expect(screen.getByRole('option', { name: 'ray.paths · 시각화' })).toBeInTheDocument()
  expect(screen.getByLabelText('@visualizations.ray.paths Overlay')).toBeDisabled()
  rerender(
    <WorkbenchViewer
      {...props}
      visualizations={{ ray: { paths: { ...props.visualizations!.ray.paths, provenance } } }}
    />,
  )
  expect(screen.getByLabelText('@visualizations.ray.paths Overlay')).not.toBeDisabled()
})

it('shows the selected result error instead of an empty Box Grid renderer', () => {
  render(
    <WorkbenchViewer
      resultContracts={{
        field: {
          task: 'wave',
          output: 'field',
          solver: { name: 'fixture', version: '1.0.0' },
          artifactType: 'fixture@1',
          catalogRevision: 'frozen',
          schema: {},
          visualization: {
            kind: 'box-grid',
            coordinateSpace: 'experiment',
          },
        },
      }}
      resultErrors={{ field: '응답에 선언된 결과 데이터가 없습니다.' }}
      experiment={null}
      experimentDocument={{} as Parameters<typeof WorkbenchViewer>[0]['experimentDocument']}
      onFindSelectionSource={vi.fn()}
      onSelectionQueryChange={vi.fn()}
      onSelectionSourcePathsChange={vi.fn()}
      onToggleViewerExpanded={vi.fn()}
      selectionQuery={null}
      selectionSourceStatus={{}}
      viewerExpanded={false}
    />,
  )
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'field' } })
  expect(screen.getAllByText('field: 응답에 선언된 결과 데이터가 없습니다.')).toHaveLength(1)
  expect(screen.queryByText('기록된 장 데이터가 없습니다.')).toBeNull()
})

it('randomly selects an overlay result once, retains selection and explicit Geometry, and reports a removed result', () => {
  const contract = {
    task: 'solid',
    output: 'field',
    solver: { name: 'fixture', version: '1' },
    artifactType: 'fixture@1',
    catalogRevision: 'frozen',
    schema: {},
    visualization: { kind: 'mesh-field' as const, coordinateSpace: 'experiment' as const },
  }
  const props: Parameters<typeof WorkbenchViewer>[0] = {
    experiment: null,
    experimentDocument: { scene: {}, evaluatedSnapshot: { sourceHash: 'source', variables: {} } } as Parameters<
      typeof WorkbenchViewer
    >[0]['experimentDocument'],
    onFindSelectionSource: vi.fn(),
    onSelectionQueryChange: vi.fn(),
    onSelectionSourcePathsChange: vi.fn(),
    onToggleViewerExpanded: vi.fn(),
    selectionQuery: null,
    selectionSourceStatus: {},
    viewerExpanded: false,
    resultContracts: { first: contract, second: contract },
    resultSourceHash: 'source',
    resultVarsHash: materialVarsHash({}),
  }
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.9)
  const { rerender } = render(<WorkbenchViewer {...props} />)
  rerender(<WorkbenchViewer {...props} autoSelectResult recordedData={{}} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('second')
  const calls = random.mock.calls.length
  rerender(<WorkbenchViewer {...props} autoSelectResult recordedData={{}} />)
  expect(random).toHaveBeenCalledTimes(calls)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('second')
  rerender(<WorkbenchViewer {...props} autoSelectResult recordedData={{}} resultContracts={{ first: contract }} />)
  expect(screen.getByText('second: 새 실행에 선택한 결과가 없습니다.')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: '' } })
  rerender(<WorkbenchViewer {...props} autoSelectResult recordedData={{}} />)
  expect(screen.getByLabelText('Viewer 결과 선택')).toHaveValue('')
  expect(screen.getByText('Geometry preview')).toBeInTheDocument()
})
