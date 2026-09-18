import { ViewerPersistenceContext, createComparisonSettings } from './comparisonSettings'
import { createComparisonCamera } from './comparisonCamera'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MeshFieldResult } from './MeshFieldResult'
import type { RecordedMeshField, createMeshFieldRenderData } from './meshFields'

vi.mock('./JscadViewer', () => ({
  default: ({ meshRenderData }: { meshRenderData: ReturnType<typeof createMeshFieldRenderData> }) => (
    <output data-testid="rendered-mesh" data-maximum={meshRenderData.maximum} data-cut={meshRenderData.cut}>
      {meshRenderData.geometries.length} render chunks
    </output>
  ),
}))

const field: RecordedMeshField = {
  label: 'stress',
  identity: 'tetra-volume',
  lengthUnit: 'm',
  valueUnit: 'Pa',
  quantity: 'Pressure',
  valueKind: 'stress',
  location: 'cell',
  points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  cells: new Uint32Array([0, 1, 2, 3]),
  values: new Float64Array([10, 0, 0, 0, 0, 0]),
  componentCount: 6,
  components: ['xx', 'yy', 'zz', 'xy', 'yz', 'xz'],
  boundaryFaces: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  boundaryCells: new Uint32Array(4),
  cellRegions: new Uint32Array([0]),
  regionIds: ['steel'],
  supportNodes: new Uint32Array([0]),
  loadPoints: new Float64Array([1, 0, 0]),
  loadVectors: new Float64Array([0, 1, 0]),
}

describe('mesh field inspection controls', () => {
  it('shows explicit Hz and phase and deforms stress at matching frequency values instead of matching indices', () => {
    const ids = new Int32Array([10, 20, 30, 40])
    const stress: RecordedMeshField = {
      ...field,
      task: 'solid',
      coordinateSpace: 'experiment',
      nodeIds: ids,
      values: new Float64Array([10, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0]),
      spectrum: {
        frequencies: new Float64Array([91, 37]),
        imaginaryValues: new Float64Array([5, 0, 0, 0, 0, 0, 30, 0, 0, 0, 0]),
      },
    }
    const displacement: RecordedMeshField = {
      ...stress,
      label: 'motion',
      location: 'node',
      valueKind: 'displacement',
      componentCount: 3,
      components: ['x', 'y', 'z'],
      valueUnit: 'm',
      values: Float64Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? (index < 12 ? 0.02 : 0.01) : 0)),
      spectrum: {
        frequencies: new Float64Array([37, 91]),
        imaginaryValues: Float64Array.from({ length: 24 }, (_, index) =>
          index % 3 === 0 ? (index < 12 ? 0.04 : 0.03) : 0,
        ),
      },
    }
    const show = (data: ReturnType<typeof createMeshFieldRenderData>) => (
      <output
        data-testid="harmonic-frame"
        data-first-x={data.geometries[0].positions[0]}
        data-upper-bound={data.bounds.max[0]}
      />
    )
    const { rerender } = render(
      <MeshFieldResult field={stress} displacementFields={[displacement]} renderViewer={show} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '위상' }))
    expect(screen.getByLabelText('stress frequency')).toHaveValue('91')
    expect(screen.getByLabelText('stress phase degrees')).toHaveValue(0)
    expect(screen.getByText(/91 Hz · 0° · 순간값/)).toBeInTheDocument()
    expect(screen.queryByLabelText('변형 배율')).not.toBeInTheDocument()
    expect(Number(screen.getByTestId('harmonic-frame').getAttribute('data-first-x'))).toBeCloseTo(0.01)
    fireEvent.change(screen.getByLabelText('stress frequency'), { target: { value: '37' } })
    expect(Number(screen.getByTestId('harmonic-frame').getAttribute('data-first-x'))).toBeCloseTo(0.02)
    const envelope = screen.getByTestId('harmonic-frame').getAttribute('data-upper-bound')
    fireEvent.change(screen.getByLabelText('stress phase'), { target: { value: '90' } })
    expect(Number(screen.getByTestId('harmonic-frame').getAttribute('data-first-x'))).toBeCloseTo(-0.04)
    expect(screen.getByTestId('harmonic-frame').getAttribute('data-upper-bound')).toBe(envelope)
    rerender(
      <MeshFieldResult
        field={{
          ...stress,
          values: stress.values.slice(0, 6),
          spectrum: {
            frequencies: new Float64Array([91]),
            imaginaryValues: stress.spectrum!.imaginaryValues.slice(0, 6),
          },
        }}
        displacementFields={[displacement]}
        renderViewer={show}
      />,
    )
    expect(screen.getByLabelText('stress frequency')).toHaveValue('37')
    expect(screen.getByRole('alert')).toHaveTextContent('선택한 주파수 37 Hz')
    expect(screen.queryByTestId('harmonic-frame')).not.toBeInTheDocument()
  })
  it('ignores saved deformation multipliers and uses real displacement or the original mesh', () => {
    const displacement: RecordedMeshField = {
      ...field,
      location: 'node',
      valueKind: 'displacement',
      componentCount: 3,
      components: ['x', 'y', 'z'],
      valueUnit: 'm',
      values: Float64Array.from({ length: 12 }, (_, index) => (index % 3 === 0 ? 0.02 : 0)),
    }
    const settings = createComparisonSettings({
      'stress:mesh.view': {
        component: 'magnitude',
        clipAxis: -1,
        clipFraction: 0.5,
        wireframe: true,
        overlays: true,
        deformationScale: 100,
      },
      'stress:mesh.scaleMode': 'manual',
      'stress:mesh.manualScale': 100,
    })
    render(
      <ViewerPersistenceContext.Provider value={{ settings, item: 'stress', camera: createComparisonCamera() }}>
        <MeshFieldResult
          field={displacement}
          renderViewer={(data) => <output data-testid="deformation">{data?.bounds.min[0]}</output>}
        />
      </ViewerPersistenceContext.Provider>,
    )
    expect(Number(screen.getByTestId('deformation').textContent)).toBeCloseTo(0.02)
    fireEvent.click(screen.getByRole('button', { name: '변형 표시' }))
    expect(Number(screen.getByTestId('deformation').textContent)).toBe(0)
    expect(screen.queryByLabelText('변형 배율')).not.toBeInTheDocument()
  })

  it('keeps harmonic pressure on its reference mesh and validates the explicitly selected phase', () => {
    const pressure: RecordedMeshField = {
      ...field,
      label: 'pressure',
      valueKind: undefined,
      location: 'node',
      componentCount: 1,
      components: ['pressure'],
      values: new Float64Array([1, 1, 1, 1]),
      spectrum: { frequencies: new Float64Array([50]), imaginaryValues: new Float64Array([2, 2, 2, 2]) },
    }
    render(<MeshFieldResult field={pressure} />)
    fireEvent.click(screen.getByRole('button', { name: '위상' }))
    expect(screen.getByLabelText('pressure frequency')).toHaveValue('50')
    expect(screen.getByText('Value (Pa)')).toBeInTheDocument()
    expect(screen.queryByText('magnitude (Pa)')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('변형 배율')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Deformation result')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Transient playback')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('pressure phase degrees'), { target: { value: '361' } })
    expect(screen.getByRole('alert')).toHaveTextContent('0°부터 360°')
  })
  it('switches physical stress components, materials, overlays and interpolated cuts', () => {
    render(<MeshFieldResult field={field} />)
    expect(screen.getByTestId('rendered-mesh')).toHaveAttribute('data-maximum', '10')
    expect(screen.getByText('vonMises (Pa)')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('stress field component'), { target: { value: '1' } })
    expect(screen.getByTestId('rendered-mesh')).toHaveAttribute('data-maximum', '0')
    expect(screen.getByText('yy (Pa)')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('stress field component'), { target: { value: 'material' } })
    expect(screen.getByText('steel')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('stress section axis'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('stress section position'), { target: { value: '0.25' } })
    expect(screen.getByTestId('rendered-mesh')).toHaveAttribute('data-cut', '0.25')
    fireEvent.click(screen.getByLabelText('구속 / 하중'))
    expect(screen.queryByText(/Green: fixed nodes/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('stress displacement scale')).not.toBeInTheDocument()
  })
})

it('retains checkboxes and component/section settings while replacing field data', () => {
  const { rerender } = render(<MeshFieldResult field={field} />)
  fireEvent.click(screen.getByLabelText('Mesh 경계선'))
  fireEvent.click(screen.getByLabelText('구속 / 하중'))
  fireEvent.change(screen.getByLabelText('stress field component'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('stress section axis'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('stress section position'), { target: { value: '0.25' } })
  rerender(
    <MeshFieldResult field={{ ...field, identity: 'new-mesh', values: new Float64Array([20, 0, 0, 0, 0, 0]) }} />,
  )
  expect(screen.getByLabelText('Mesh 경계선')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByLabelText('구속 / 하중')).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByLabelText('stress field component')).toHaveValue('0')
  expect(screen.getByTestId('rendered-mesh')).toHaveAttribute('data-maximum', '20')
  expect(screen.getByTestId('rendered-mesh')).toHaveAttribute('data-cut', '0.25')
})
