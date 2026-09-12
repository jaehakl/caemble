import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { SavedExperimentRecord, UserData } from '@/api'
import { ApiError } from '@/api/http'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { DefinitionFormValues } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { centeredThumbnailCrop, cropThumbnail, type ViewerCapture } from '@/features/viewer/persistence/viewerThumbnail'
import { ThumbnailCropEditor } from '@/features/viewer/persistence/ThumbnailCropEditor'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { privateQueryScope } from '@/features/auth/queryKeys'
import { availableExperimentsQueryOptions } from './queryOptions'
import { ExperimentShowcase } from './ExperimentShowcase'
import { experimentPlaceholder } from './ExperimentCard'

export function experimentSaveDefaults(workbench: CaeWorkbenchState, copy = false): DefinitionFormValues {
  const record = workbench.experimentRecord
  const key =
    record?.experiment_key ??
    (workbench.experimentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
      'untitled-experiment')
  return {
    namespace: record?.namespace ?? workbench.experimentNamespaces[0] ?? '',
    repository: record?.repository_slug ?? 'experiments',
    key: copy && record ? `${key}-copy` : key,
    name: workbench.experimentName,
    description: workbench.experimentDescription,
    bump: 'patch',
  }
}

export function SaveExperimentDialog({
  user,
  workbench,
  initialTarget,
  capture,
  captureError,
  includePreflight,
  setIncludePreflight,
  preflightId,
  preflightReason,
  onClose,
  onSaved,
}: {
  user: UserData | null
  workbench: CaeWorkbenchState
  initialTarget: SavedExperimentRecord | null
  capture: ViewerCapture | null
  captureError: string
  includePreflight: boolean
  setIncludePreflight: (value: boolean) => void
  preflightId?: string
  preflightReason: string
  onClose: () => void
  onSaved: () => void
}) {
  const [values, setValues] = useState(() => experimentSaveDefaults(workbench, !initialTarget))
  const [target, setTarget] = useState(initialTarget)
  const [crop, setCrop] = useState(() => (capture ? centeredThumbnailCrop(capture.width, capture.height) : null))
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [savedId, setSavedId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const request = useRef<{ signature: string; id: string; thumbnail?: string } | null>(null)
  const signature = JSON.stringify({
    values,
    target: target?.id,
    hash: target?.source_hash,
    source: workbench.experiment?.sourceBundle,
    capture: capture?.url,
    crop,
    preflightId: includePreflight ? preflightId : null,
  })
  const available = useQuery(availableExperimentsQueryOptions(privateQueryScope(user)))
  const duplicate =
    !target &&
    request.current?.signature !== signature &&
    [...(available.data?.mine ?? []), ...(available.data?.demos ?? [])].some(
      (row) =>
        row.namespace === values.namespace.trim() &&
        row.repository_slug === values.repository.trim() &&
        row.experiment_key === values.key.trim(),
    )
  const submit = async () => {
    if (submitting.current || savedId || duplicate) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      if (request.current?.signature !== signature) {
        let thumbnail: string | undefined
        if (capture && crop) {
          try {
            thumbnail = await cropThumbnail(capture, crop)
          } catch (cause) {
            toast.info(`${cause instanceof Error ? cause.message : String(cause)} 기본 이미지로 저장합니다.`)
          }
        }
        request.current = { signature, id: crypto.randomUUID(), thumbnail }
      }
      const mode = target ? 'new_version' : 'create'
      const result = await workbench.saveExperiment(values, mode, {
        target,
        thumbnail: request.current.thumbnail,
        preflightBatchId: includePreflight ? preflightId : undefined,
        requestId: request.current.id,
      })
      request.current = null
      setSavedId(result.id)
      onSaved()
      toast.success(`Experiment v${result.version}을 저장했습니다.`)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) request.current = null
      setError(cause instanceof Error ? cause.message : String(cause))
      void available.refetch()
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="flex h-[90dvh] w-[95vw] flex-col sm:max-w-[1400px]">
        <DialogHeader>
          <DialogTitle>Save As</DialogTitle>
          <DialogDescription>새 Experiment를 만들거나 기존 Experiment의 새 버전으로 저장합니다.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2 lg:overflow-hidden">
          <div className="flex min-h-[320px] flex-col lg:min-h-0">
            <Button
              variant="outline"
              className="m-3"
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setValues(experimentSaveDefaults(workbench, true))
                setSavedId(null)
                setError('')
              }}
            >
              새 Experiment
            </Button>
            <div className="min-h-0 flex-1">
              <ExperimentShowcase
                mode="save"
                busy={busy}
                user={user}
                selectedId={savedId ?? target?.id ?? null}
                revealId={savedId}
                onSelect={(row) => {
                  setTarget(row)
                  setSavedId(null)
                  setError('')
                  setValues((current) => ({
                    ...current,
                    namespace: row.namespace,
                    repository: row.repository_slug,
                    key: row.experiment_key,
                  }))
                }}
              />
            </div>
          </div>
          <form
            className="min-h-0 space-y-4 overflow-auto p-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <p className="rounded border bg-muted p-3 text-sm">
              {target
                ? `${target.namespace}/${target.repository_slug}/${target.experiment_key} · 새 버전`
                : '새 Experiment · v0.1.0'}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(['namespace', 'repository', 'key'] as const).map((field) => (
                <label key={field} className="grid gap-1 text-sm">
                  {field}
                  <Input
                    required
                    value={values[field]}
                    disabled={busy || Boolean(target) || Boolean(savedId)}
                    onChange={(event) => setValues({ ...values, [field]: event.target.value })}
                  />
                </label>
              ))}
            </div>
            {duplicate ? (
              <p role="alert" className="text-sm text-destructive">
                이미 사용 중인 저장 위치입니다. 왼쪽에서 기존 Experiment를 선택하거나 key를 변경하세요.
              </p>
            ) : null}
            {target ? (
              <label className="grid gap-1 text-sm">
                Version 증가
                <select
                  aria-label="Version 증가"
                  value={values.bump}
                  disabled={busy || Boolean(savedId)}
                  onChange={(event) =>
                    setValues({ ...values, bump: event.target.value as DefinitionFormValues['bump'] })
                  }
                  className="rounded border p-2"
                >
                  <option value="patch">Patch</option>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              이름
              <Input
                required
                value={values.name}
                disabled={busy || Boolean(savedId)}
                onChange={(event) => setValues({ ...values, name: event.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              설명
              <textarea
                className="min-h-20 rounded border p-2"
                value={values.description}
                disabled={busy || Boolean(savedId)}
                onChange={(event) => setValues({ ...values, description: event.target.value })}
              />
            </label>
            {capture && crop ? (
              <ThumbnailCropEditor
                capture={capture}
                crop={crop}
                onChange={setCrop}
                disabled={busy || Boolean(savedId)}
              />
            ) : (
              <div>
                <p role="status" className="text-sm text-muted-foreground">
                  {captureError || '캡처할 화면이 없어 기본 이미지를 사용합니다.'}
                </p>
                <img src={experimentPlaceholder} alt="기본 대표이미지" className="mt-2 aspect-[4/3] w-40 rounded" />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includePreflight && Boolean(preflightId)}
                disabled={!preflightId || busy || Boolean(savedId)}
                onChange={(event) => setIncludePreflight(event.target.checked)}
              />
              Preflight 결과 함께 저장
            </label>
            {!preflightId && preflightReason ? (
              <p className="text-xs text-muted-foreground">{preflightReason}</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {savedId ? (
              <p role="status" className="text-sm">
                저장했습니다. 왼쪽 목록에서 저장된 Experiment를 확인할 수 있습니다.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                {savedId ? '닫기' : '취소'}
              </Button>
              <Button type="submit" disabled={busy || Boolean(savedId) || duplicate || !available.isSuccess}>
                {busy ? '저장 중…' : '저장'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
