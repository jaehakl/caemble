import { materialVarsHash } from '@/lib/material/resolution'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkbenchViewer } from './WorkbenchViewer'

vi.mock('@/features/viewer/viewer/CadViewer', () => ({ default: () => <div>Geometry preview</div> }))
vi.mock('@/features/viewer/viewer/MeshFieldResult', () => ({ MeshFieldResult: () => <div>Stored volume field</div> }))
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
    experimentDocument: { evaluatedSnapshot: { sourceHash: 'source', variables: {} } } as Parameters<
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
        visualization: { kind: 'mesh-field', coordinateSpace: 'experiment' },
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

it('shows the selected result error instead of an empty structured-field renderer', () => {
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
            kind: 'structured-field',
            coordinateSpace: 'experiment',
            grid: { xyzAxes: [3, 2, 1], sampleAxis: 0, sampleKind: 'frequency', componentAxis: 4 },
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
    experimentDocument: { evaluatedSnapshot: { sourceHash: 'source', variables: {} } } as Parameters<
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
