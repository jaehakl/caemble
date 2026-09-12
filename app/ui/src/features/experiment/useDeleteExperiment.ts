import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type SavedExperimentRecord } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { invalidateExperimentMutation } from './queryInvalidation'

export function useDeleteExperiment(
  queryScope: PrivateQueryScope,
  selectedId: number | null,
  onDeleteSelected?: (row: SavedExperimentRecord) => void,
) {
  const queryClient = useQueryClient()
  const deleteMutation = useMutation({
    mutationFn: async (row: SavedExperimentRecord) => {
      const usage = (await dbTables.Experiment.usage([row.id])).items[0]
      const counts = usage?.derivedCounts ?? row.derivedCounts
      const linked = counts ? counts.measurements + counts.recordedData + counts.calculations : 0
      const detail = linked
        ? `\n연결 데이터 ${linked.toLocaleString()}개도 함께 삭제됩니다 (Measurement ${counts!.measurements}, RecordedData ${counts!.recordedData}, Calculation ${counts!.calculations}).`
        : ''
      const demoDetail = row.isDemo
        ? '\n공개 Demo에서 즉시 제거되며, 다음 정상 Demo가 대표 Demo로 승격될 수 있습니다.'
        : ''
      const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
      if (
        !window.confirm(
          `${row.namespace}/${row.repository_slug}/${row.experiment_key}@${version}을 영구 삭제할까요?${detail}${demoDetail}`,
        )
      ) {
        return false
      }
      await dbTables.Experiment.deleteRows([row.id])
      return true
    },
    onSuccess: async (deleted, row) => {
      if (!deleted) return
      if (row.id === selectedId) onDeleteSelected?.(row)
      await invalidateExperimentMutation(queryClient, queryScope, row.id)
      toast.success('Experiment Version을 삭제했습니다.')
    },
    onError: (cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : 'Experiment Version을 삭제하지 못했습니다.')
    },
  })
  return deleteMutation
}
