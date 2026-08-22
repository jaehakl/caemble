import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { dbTables, geometryApi, getListRequest } from '@/api'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function useGeometryManagerMutations({
  geometry,
  listScope,
  selectedPackageId,
  selectedVersionId,
  setCheckedPackageIds,
  setSelectedPackageId,
  setSelectedVersionId,
}: {
  geometry: GeometryManagerState
  listScope: 'visible' | 'mine'
  selectedPackageId: number | null
  selectedVersionId: number | null
  setCheckedPackageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPackageId: (packageId: number | null) => void
  setSelectedVersionId: (versionId: number | null) => void
}) {
  const queryClient = useQueryClient()
  const selectedPackageIdRef = useRef(selectedPackageId)
  const selectedVersionIdRef = useRef(selectedVersionId)
  selectedPackageIdRef.current = selectedPackageId
  selectedVersionIdRef.current = selectedVersionId

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['geometry'] })
    await geometry.refreshRepositories()
  }, [geometry, queryClient])

  const namespaceMutation = useMutation({
    mutationFn: (value: string) => geometry.setNamespace(value),
    onSuccess: async () => {
      await invalidate()
      toast.success('기본 Geometry namespace를 변경했습니다. 기존 좌표는 유지됩니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const archiveVersionMutation = useMutation({
    mutationFn: (versionId: number) => geometry.archiveVersion(versionId),
    onSuccess: async () => {
      await invalidate()
      toast.success('Geometry version을 archive했습니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const deleteVersionMutation = useMutation({
    mutationFn: (versionId: number) => dbTables.GeometryVersion.deleteRows([versionId]),
    onSuccess: async (_, versionId) => {
      if (selectedVersionIdRef.current === versionId) setSelectedVersionId(null)
      await invalidate()
      toast.success('Geometry version을 삭제했습니다.')
    },
    onError: async (error) => {
      await invalidate()
      toast.error(message(error))
    },
  })
  const deletePackagesMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const packageVersions = (
        await Promise.all(
          ids.map((id) =>
            dbTables.GeometryVersion.listRows({
              ...getListRequest(listScope),
              limit: null,
              filter: { package_id: [id, id] },
            }),
          ),
        )
      ).flatMap((response) => response.items)
      const localIds = new Set([
        ...geometry.currentSnapshot.modules.map((module) => module.geometryVersionId),
        ...geometry.managerModules.map((module) => module.geometryVersionId),
        ...geometry.experimentModules.map((module) => module.geometryVersionId),
        ...Object.values(geometry.draftVersions).flatMap((draft) =>
          draft.baseGeometryVersionId ? [draft.baseGeometryVersionId] : [],
        ),
      ])
      if (packageVersions.some((version) => localIds.has(version.id))) {
        throw new Error('현재 브라우저의 snapshot, staging 또는 draft가 참조하는 Package는 삭제할 수 없습니다.')
      }
      const deletingVersionIds = new Set(packageVersions.map((version) => version.id))
      const usage = await geometryApi.versionUsage([...deletingVersionIds])
      if (
        usage.items.some(
          (item) =>
            item.experimentCount > 0 ||
            item.dependentVersionIds.some((dependentId) => !deletingVersionIds.has(dependentId)),
        )
      ) {
        throw new Error('저장된 Experiment 또는 선택 밖의 Geometry가 참조하는 Package는 삭제할 수 없습니다.')
      }
      await dbTables.GeometryPackage.deleteRows(ids)
    },
    onSuccess: async (_, ids) => {
      if (selectedPackageIdRef.current && ids.includes(selectedPackageIdRef.current)) setSelectedPackageId(null)
      setCheckedPackageIds(new Set())
      await invalidate()
      toast.success(`${ids.length}개 Geometry package를 삭제했습니다.`)
    },
    onError: async (error) => {
      await invalidate()
      toast.error(message(error))
    },
  })

  const localVersionIds = useMemo(
    () =>
      new Set([
        ...geometry.currentSnapshot.modules.map((module) => module.geometryVersionId),
        ...geometry.managerModules.map((module) => module.geometryVersionId),
        ...geometry.experimentModules.map((module) => module.geometryVersionId),
        ...Object.values(geometry.draftVersions).flatMap((draft) =>
          draft.baseGeometryVersionId ? [draft.baseGeometryVersionId] : [],
        ),
      ]),
    [geometry.currentSnapshot.modules, geometry.draftVersions, geometry.experimentModules, geometry.managerModules],
  )

  return {
    archiveVersionMutation,
    deletePackagesMutation,
    deleteVersionMutation,
    invalidate,
    localVersionIds,
    namespaceMutation,
  }
}
