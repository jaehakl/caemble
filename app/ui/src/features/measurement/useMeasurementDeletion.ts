import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dbTables, type PersistedMeasurementRecord } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { emitRuntimeActivity, type RuntimeActivityCallback } from '@/features/runtime-console/types'
import { invalidateMeasurementMutation } from './queryInvalidation'
import type { CaeDataSelection } from './useCaeDataSelection'

export function useMeasurementDeletion(context: {
  user: { id: string; roles: readonly string[] } | null
  queryScope: PrivateQueryScope
  experimentId: number | null
  workspaceSession: number
  publicDataWarning: boolean
  selection: Pick<CaeDataSelection, 'forgetMeasurement'>
  onActivity: RuntimeActivityCallback
}) {
  const queryClient = useQueryClient()
  const latest = useRef(context)
  latest.current = context
  const pending = useRef(new Set<number>())
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<number>>(new Set())

  const canDelete = (row: PersistedMeasurementRecord) =>
    Boolean(
      context.user &&
      (context.user.roles.includes('admin') ||
        (context.user.roles.includes('user') && row.user_id === context.user.id)),
    )

  const deleteMeasurement = async (row: PersistedMeasurementRecord) => {
    if (!canDelete(row) || pending.current.has(row.id)) return
    if (
      !window.confirm(
        `Measurement #${row.id}를 영구 삭제할까요?\n연결된 RecordedData와 CalculationData도 함께 삭제됩니다.${context.publicDataWarning ? '\n공개 Demo 데이터에 즉시 반영됩니다.' : ''}`,
      )
    )
      return
    pending.current.add(row.id)
    setDeletingIds(new Set(pending.current))
    try {
      await dbTables.Measurement.deleteRows([row.id])
      const current = latest.current
      if (
        current.queryScope === context.queryScope &&
        current.experimentId === context.experimentId &&
        current.workspaceSession === context.workspaceSession
      ) {
        current.selection.forgetMeasurement(row.id)
      }
      await invalidateMeasurementMutation(queryClient, context.queryScope, row.experiment_id, [row.id])
    } catch (cause) {
      emitRuntimeActivity(context.onActivity, {
        source: 'cae',
        level: 'error',
        phase: 'measurement.delete',
        message: `Measurement #${row.id} 삭제 실패: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: { measurementId: row.id, experimentId: row.experiment_id },
      })
    } finally {
      pending.current.delete(row.id)
      setDeletingIds(new Set(pending.current))
    }
  }

  return { canDelete, deleteMeasurement, deletingIds }
}
