import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { SavedExperimentRecord } from '@/api'
import { API_URL } from '@/api/http'

export const experimentPlaceholder = '/images/experiment-placeholder.svg'

export function ExperimentCard({
  row,
  selected,
  deleting,
  onSelect,
  onEdit,
  onDelete,
  onVersions,
  disabled = false,
}: {
  row: SavedExperimentRecord
  selected: boolean
  deleting?: boolean
  onSelect: () => void
  onEdit?: () => void
  disabled?: boolean
  onDelete?: () => void
  onVersions?: () => void
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
  const url = row.thumbnail_url?.startsWith('/experiment/') ? `${API_URL}${row.thumbnail_url}` : row.thumbnail_url
  const thumbnail = url && row.thumbnail_url !== failedUrl ? url : experimentPlaceholder
  const actionClass =
    'relative z-10 rounded-md bg-black/55 p-2 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-white'
  return (
    <article
      data-experiment-id={row.id}
      className={`relative isolate aspect-[4/3] overflow-hidden rounded-xl bg-slate-800 text-white ring-offset-2 ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <img
        alt=""
        src={thumbnail}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
        onError={() => setFailedUrl(row.thumbnail_url ?? null)}
      />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-black/80 via-black/5 to-black/85" />
      <button
        type="button"
        aria-label={`${row.name} v${version} 선택`}
        aria-pressed={selected}
        onClick={onSelect}
        disabled={disabled}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
      />
      <div className="pointer-events-none relative flex items-start gap-2 p-3">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-base font-semibold" title={row.name}>
          {row.name}
        </h3>
        <div className="pointer-events-auto flex shrink-0 gap-1">
          {onEdit ? (
            <button type="button" aria-label={`${row.name} v${version} 편집`} className={actionClass} onClick={onEdit}>
              <Pencil className="size-4" />
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              aria-label={`${row.name} v${version} 삭제`}
              disabled={deleting}
              className={`${actionClass} disabled:opacity-50`}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 p-3">
        <p className="line-clamp-2 min-w-0 flex-1 text-sm text-white/90">{row.description || '설명 없음'}</p>
        {onVersions ? (
          <button
            type="button"
            aria-label={`${row.name} 버전 목록`}
            onClick={onVersions}
            className={`${actionClass} pointer-events-auto shrink-0 text-xs`}
          >
            v{version}
          </button>
        ) : (
          <span className="shrink-0 rounded-md bg-black/55 px-2 py-1 text-xs">v{version}</span>
        )}
      </div>
    </article>
  )
}
