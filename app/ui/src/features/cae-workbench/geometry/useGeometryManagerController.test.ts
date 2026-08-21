// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import { useGeometryManagerController } from './useGeometryManagerController'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

function renderController() {
  const setManagerNamespace = vi.fn()
  const setManagerRepository = vi.fn()
  const setSelectedCoordinate = vi.fn()
  const setSelectedCatalogKey = vi.fn()
  const setManagerView = vi.fn()
  const geometry = {
    managerNamespace: 'team',
    managerRepository: 'shared',
    managerView: 'workspace',
    selectedCatalogKey: null,
    setManagerNamespace,
    setManagerRepository,
    setSelectedCoordinate,
    setSelectedCatalogKey,
    setManagerView,
  } as unknown as GeometryManagerState

  const hook = renderHook(() =>
    useGeometryManagerController({
      geometry,
      initialPackageId: null,
      initialVersionId: null,
    }),
  )

  return {
    ...hook,
    setManagerNamespace,
    setManagerRepository,
    setSelectedCoordinate,
    setSelectedCatalogKey,
    setManagerView,
  }
}

describe('useGeometryManagerController', () => {
  it('changes Repository only when the Repository filter changes', () => {
    const { result, setManagerNamespace, setManagerRepository } = renderController()

    act(() => result.current.changeRepository('other'))

    expect(setManagerRepository).toHaveBeenCalledWith('other')
    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(result.current.filters.namespace).toBe('team')
    expect(result.current.filters.repository).toBe('shared')
  })

  it('resets Repository when the Namespace filter changes', () => {
    const { result, setManagerNamespace, setManagerRepository } = renderController()

    act(() => result.current.changeNamespace('another'))

    expect(setManagerNamespace).toHaveBeenCalledWith('another')
    expect(setManagerRepository).toHaveBeenCalledWith('all')
  })

  it('keeps filters untouched for every selection action', () => {
    const { result, setManagerNamespace, setManagerRepository } = renderController()
    const coordinate = 'caemble:geometry/team/shared/plate@local' as GeometryModuleCoordinate

    act(() => result.current.selectExample('basketball-goal'))
    act(() => result.current.selectPackage(7))
    act(() => result.current.selectVersion(11, coordinate))
    act(() => result.current.selectDraft(coordinate))
    act(() => result.current.openDraft(coordinate))
    act(() => result.current.clearSelection())

    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(setManagerRepository).not.toHaveBeenCalled()
    expect(result.current.filters.namespace).toBe('team')
    expect(result.current.filters.repository).toBe('shared')
  })
})
