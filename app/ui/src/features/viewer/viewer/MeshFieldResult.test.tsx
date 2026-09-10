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
    fireEvent.click(screen.getByLabelText('Supports / loads'))
    expect(screen.queryByText(/Green: fixed nodes/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('stress displacement scale')).not.toBeInTheDocument()
  })
})
