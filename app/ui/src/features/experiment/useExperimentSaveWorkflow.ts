import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { dbTables } from '@/api'
import { ApiError } from '@/api/http'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchDialog } from '@/features/cae-workbench/caePageTypes'
import type { usePreflight } from '@/features/measurement/usePreflight'
import {
  captureViewer,
  centeredThumbnailCrop,
  cropThumbnail,
  type ViewerCapture,
} from '@/features/viewer/persistence/viewerThumbnail'
import { experimentSaveDefaults } from './SaveExperimentDialog'

export function useExperimentSaveWorkflow(
  workbench: CaeWorkbenchState,
  preflight: ReturnType<typeof usePreflight>,
  viewer: RefObject<HTMLDivElement | null>,
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>,
) {
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const [capture, setCapture] = useState<ViewerCapture | null>(null)
  const [captureError, setCaptureError] = useState('')
  const [includePreflight, setIncludePreflight] = useState(true)
  const [expired, setExpired] = useState(false)
  const expiresAt = preflight.result?.payload.expires_at
  useEffect(() => {
    if (!expiresAt) {
      setExpired(false)
      return
    }
    const remaining = Date.parse(expiresAt) - Date.now()
    setExpired(!Number.isFinite(remaining) || remaining <= 0)
    if (remaining > 0) {
      const timer = window.setTimeout(() => setExpired(true), remaining)
      return () => window.clearTimeout(timer)
    }
  }, [expiresAt])
  const retry = useRef<{ signature: string; args: Parameters<CaeWorkbenchState['saveExperiment']> } | null>(null)
  const matches = Boolean(
    preflight.result &&
    JSON.stringify(preflight.result.experiment.sourceBundle) === JSON.stringify(workbench.experiment?.sourceBundle),
  )
  const preflightId = matches && !expired ? preflight.result?.payload.id : undefined
  const preflightReason = expired
    ? 'Preflight가 만료되었습니다. 다시 실행하세요.'
    : preflight.result
      ? '현재 소스와 Preflight 소스가 다릅니다. 다시 실행하세요.'
      : '함께 저장할 완료된 Preflight가 없습니다.'
  const takeCapture = async () => {
    try {
      const result = await captureViewer(viewer.current)
      setCapture(result)
      setCaptureError('')
      return result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setCapture(null)
      setCaptureError(message)
      return null
    }
  }
  const saveAs = async (version = false) => {
    if (active.current) return
    active.current = true
    setBusy(true)
    try {
      await takeCapture()
      setDialog(version ? 'save-experiment-version' : 'save-experiment-as')
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  const save = async () => {
    if (active.current) return
    if (!workbench.experimentRecord) {
      await saveAs()
      return
    }
    if (!workbench.experimentManageable) {
      toast.error('이 Experiment는 Save As로 저장하세요.')
      return
    }
    active.current = true
    setBusy(true)
    try {
      const values = experimentSaveDefaults(workbench)
      const signature = JSON.stringify({
        source: workbench.experiment?.sourceBundle,
        id: workbench.experimentId,
        values,
        preflightId: includePreflight ? preflightId : undefined,
      })
      if (retry.current?.signature !== signature) retry.current = null
      if (!retry.current) {
        const usage = (await dbTables.Experiment.usage([workbench.experimentRecord.id])).items[0]
        if (!usage) throw new Error('최신 사용량을 확인할 수 없습니다. 다시 시도하세요.')
        const snapshot = await takeCapture()
        if (usage.derivedCounts.measurements > 0) {
          setDialog('save-experiment-version')
          return
        }
        let thumbnail: string | undefined
        if (snapshot) {
          try {
            thumbnail = await cropThumbnail(snapshot, centeredThumbnailCrop(snapshot.width, snapshot.height))
          } catch (cause) {
            toast.info(`${cause instanceof Error ? cause.message : String(cause)} 기존 썸네일을 유지합니다.`)
          }
        } else toast.info('Viewer를 캡처할 수 없어 기존 썸네일을 유지합니다.')
        retry.current = {
          signature,
          args: [
            values,
            'overwrite',
            { requestId: crypto.randomUUID(), thumbnail, preflightBatchId: includePreflight ? preflightId : undefined },
          ],
        }
      }
      const result = await workbench.saveExperiment(...retry.current.args)
      retry.current = null
      preflight.clear()
      toast.success(`Experiment v${result.version}을 저장했습니다.`)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) retry.current = null
      toast.error(cause instanceof Error ? cause.message : String(cause))
      void workbench.refreshExperimentUsage().catch(() => undefined)
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  return {
    busy,
    capture,
    captureError,
    includePreflight,
    setIncludePreflight,
    preflightId,
    preflightReason,
    save,
    saveAs,
  }
}
