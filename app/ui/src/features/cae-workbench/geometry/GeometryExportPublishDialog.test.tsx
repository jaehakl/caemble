// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeometryManagerState } from './useGeometryWorkspaceState'
import { GeometryExportPublishDialog } from './GeometryExportPublishDialog'

const cad = vi.hoisted(() => ({ compile: vi.fn(async () => undefined) }))

vi.mock('@/lib/cad', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cad')>()),
  compileCadDocument: cad.compile,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function geometryState(source: string, overrides: Partial<GeometryManagerState> = {}) {
  const publishNewGeometry = vi.fn(async () => ({
    stageError: null,
    version: { id: 42, coordinate: 'caemble:geometry/jlee/common/second-part@0.1.0' },
  }))
  return {
    entrySource: source,
    entryExports: ['FirstPart', 'SecondPart'],
    namespace: 'jlee',
    repositories: [{ id: 7, namespace: 'jlee', slug: 'common', description: null, archived_at: null }] as never,
    currentSnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
    experimentAvailableOverlay: {},
    busy: false,
    refreshRepositories: vi.fn(async () => []),
    setNamespace: vi.fn(async (value: string) => value),
    publishNewGeometry,
    ...overrides,
  } as unknown as GeometryManagerState
}

describe('GeometryExportPublishDialog', () => {
  it('projects one export, compiles and publishes it, then copies the exact import', async () => {
    const user = userEvent.setup()
    const source = `import { type Geometry } from '@caemble/core'
const Shared: Geometry = () => <box />
export const FirstPart: Geometry = () => <Shared id="first" />
export const SecondPart: Geometry = () => <cylinder radius={2} height={3} />
`
    const geometry = geometryState(source)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<GeometryExportPublishDialog geometry={geometry} onOpenChange={vi.fn()} open />)

    expect(screen.getByLabelText('Package name')).toHaveValue('first-part')
    await user.selectOptions(screen.getByLabelText('Export'), 'SecondPart')
    expect(screen.getByLabelText('Package name')).toHaveValue('second-part')
    const sourcePreview = screen.getByLabelText('Reconstructed TSX source')
    expect(sourcePreview).toHaveAttribute('readonly')
    expect((sourcePreview as HTMLTextAreaElement).value).toContain('export const SecondPart')
    expect((sourcePreview as HTMLTextAreaElement).value).not.toContain('FirstPart')

    await user.type(screen.getByLabelText('Description'), 'Published from the Workbench')
    await user.click(screen.getByRole('button', { name: 'Geometry 발행' }))

    await waitFor(() => expect(geometry.publishNewGeometry).toHaveBeenCalledOnce())
    expect(cad.compile).toHaveBeenCalledOnce()
    expect(geometry.publishNewGeometry).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Published from the Workbench',
        exportName: 'SecondPart',
        packageName: 'second-part',
        repository: 'common',
        repositoryId: 7,
        source: expect.stringContaining('export const SecondPart'),
      }),
    )
    const snippet = 'import { SecondPart } from "caemble:geometry/jlee/common/second-part@0.1.0"'
    expect(await screen.findByText(snippet)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '코드 복사' }))
    expect(writeText).toHaveBeenCalledWith(snippet)
  })

  it('sets a missing namespace before showing the publish form', async () => {
    const user = userEvent.setup()
    const setNamespace = vi.fn(async (value: string) => value)
    const geometry = geometryState('export const FirstPart = () => <box />', {
      namespace: null,
      setNamespace,
    })
    render(<GeometryExportPublishDialog geometry={geometry} onOpenChange={vi.fn()} open />)

    await user.type(screen.getByLabelText('Namespace'), 'designer')
    await user.click(screen.getByRole('button', { name: 'Namespace 설정' }))
    await waitFor(() => expect(setNamespace).toHaveBeenCalledWith('designer'))
  })

  it('keeps the opening source snapshot and blocks submit after geometry.tsx changes', async () => {
    const user = userEvent.setup()
    const source = `export const FirstPart = () => <box />
export const SecondPart = () => <cylinder radius={2} height={3} />`
    const geometry = geometryState(source)
    const { rerender } = render(<GeometryExportPublishDialog geometry={geometry} onOpenChange={vi.fn()} open />)

    rerender(
      <GeometryExportPublishDialog
        geometry={{ ...geometry, entrySource: `${source}\n// changed after opening` }}
        onOpenChange={vi.fn()}
        open
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Geometry 발행' }))

    expect(screen.getByRole('alert')).toHaveTextContent('팝업을 연 뒤 geometry.tsx가 변경되었습니다')
    expect(cad.compile).not.toHaveBeenCalled()
    expect(geometry.publishNewGeometry).not.toHaveBeenCalled()
  })

  it('does not publish when the reconstructed module fails compilation', async () => {
    const user = userEvent.setup()
    const geometry = geometryState('export const FirstPart = () => <box />')
    cad.compile.mockRejectedValueOnce(new Error('synthetic compile failed'))
    render(<GeometryExportPublishDialog geometry={geometry} onOpenChange={vi.fn()} open />)

    await user.click(screen.getByRole('button', { name: 'Geometry 발행' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('synthetic compile failed')
    expect(geometry.publishNewGeometry).not.toHaveBeenCalled()
  })

  it('publishes into a selected existing Repository', async () => {
    const user = userEvent.setup()
    const geometry = geometryState('export const FirstPart = () => <box />', {
      repositories: [{ id: 7, namespace: 'jlee', slug: 'design', archived_at: null }] as never,
    })
    render(<GeometryExportPublishDialog geometry={geometry} onOpenChange={vi.fn()} open />)

    await user.selectOptions(screen.getByLabelText('Repository'), '7')
    await user.click(screen.getByRole('button', { name: 'Geometry 발행' }))

    await waitFor(() =>
      expect(geometry.publishNewGeometry).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'design', repositoryId: 7 }),
      ),
    )
  })

  it('shows an @local dependency error and disables publishing', () => {
    const source = `import { Child } from 'caemble:geometry/jlee/common/child@local'
export const FirstPart = () => <Child id="child" />
export const SecondPart = () => <box />
`
    render(<GeometryExportPublishDialog geometry={geometryState(source)} onOpenChange={vi.fn()} open />)
    expect(screen.getByRole('alert')).toHaveTextContent('Publish local Geometry dependency first')
    expect(screen.getByRole('button', { name: 'Geometry 발행' })).toBeDisabled()
  })
})
