import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ViewerPresentationMenu, type ViewerPresentationActions } from './ViewerPresentationMenu'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), crop: vi.fn() }))
vi.mock('@/features/viewer/persistence/viewerThumbnail', () => ({
  captureViewer: mocks.capture,
  cropThumbnail: mocks.crop,
  centeredThumbnailCrop: () => ({ x: 0, y: 0, width: 640, height: 480 }),
}))
vi.mock('@/features/viewer/persistence/ThumbnailCropEditor', () => ({ ThumbnailCropEditor: () => <div>4:3 crop</div> }))
const defaults = {
  version: 1 as const,
  selectedResult: 'signal',
  settings: { 'signal:box.overlay': true },
  camera: null,
}
let actions: ViewerPresentationActions
beforeEach(() => {
  actions = {
    experimentId: 7,
    measurementId: 41,
    hasInitialView: true,
    canSaveInitialView: true,
    update: vi.fn().mockResolvedValue({}),
  }
  mocks.capture.mockReset().mockResolvedValue({ url: 'data:image/png;base64,capture', width: 640, height: 480 })
  mocks.crop.mockReset().mockResolvedValue('data:image/webp;base64,image')
})

it('saves and clears a single initial-view bundle without replacing the image', async () => {
  render(<ViewerPresentationMenu actions={actions} snapshot={() => defaults} captureNode={() => null} />)
  fireEvent.keyDown(screen.getByRole('button', { name: '초기 화면·대표이미지' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitem', { name: '현재 화면을 초기 화면으로 저장' }))
  await waitFor(() => expect(actions.update).toHaveBeenCalledWith({ initialView: { ...defaults, measurementId: 41 } }))
  fireEvent.keyDown(screen.getByRole('button', { name: '초기 화면·대표이미지' }), { key: 'ArrowDown' })
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '초기 화면 설정 해제' })).toBeEnabled())
  fireEvent.click(screen.getByRole('menuitem', { name: '초기 화면 설정 해제' }))
  await waitFor(() => expect(actions.update).toHaveBeenLastCalledWith({ initialView: null }))
})

it('keeps image replacement independent and retains the dialog on a failed save', async () => {
  vi.mocked(actions.update).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
  render(<ViewerPresentationMenu actions={actions} snapshot={() => defaults} captureNode={() => null} />)
  fireEvent.keyDown(screen.getByRole('button', { name: '초기 화면·대표이미지' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitem', { name: '대표이미지 변경' }))
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  await screen.findByRole('alert')
  expect(actions.update).toHaveBeenCalledWith({ thumbnail: 'data:image/webp;base64,image' })
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

it('disables initial-view saving for temporary or dirty-source results', () => {
  render(
    <ViewerPresentationMenu
      actions={{ ...actions, canSaveInitialView: false }}
      snapshot={() => defaults}
      captureNode={() => null}
    />,
  )
  fireEvent.keyDown(screen.getByRole('button', { name: '초기 화면·대표이미지' }), { key: 'ArrowDown' })
  expect(screen.getByRole('menuitem', { name: '현재 화면을 초기 화면으로 저장' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '대표이미지 변경' })).toBeEnabled()
})
