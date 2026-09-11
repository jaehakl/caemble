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
