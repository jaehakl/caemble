import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkbenchViewer } from './WorkbenchViewer'

vi.mock('@/features/viewer/viewer/CadViewer', () => ({ default: () => <div>Geometry preview</div> }))
vi.mock('@/features/viewer/viewer/MeshFieldResult', () => ({ MeshFieldResult: () => <div>Stored volume field</div> }))
vi.mock('@/features/viewer/viewer/meshFields', () => ({
  parseRecordedMeshFields: () => ({
    fields: [{ label: 'displacement', identity: 'mesh' }],
    errors: [],
    labels: ['displacement'],
  }),
}))

it('shows stored mesh results centrally, permits Geometry review, and displays download progress', () => {
  render(
    <WorkbenchViewer
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
  expect(screen.getByText('Stored volume field')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('4/40')
  fireEvent.change(screen.getByLabelText('Viewer 결과 선택'), { target: { value: 'geometry' } })
  expect(screen.getByText('Geometry preview')).toBeTruthy()
  expect(screen.queryByText('Stored volume field')).toBeNull()
})
