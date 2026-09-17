import { Maximize2, Minimize2 } from 'lucide-react'
import type { CadViewerPickMode, CadViewerSource } from './model'

export type CameraView = 'default' | 'x' | 'y' | 'z'

export function ViewerToolbar({
  availableSources = [],
  meshMode = false,
  onPickModeChange,
  onSetCameraView,
  onToggleSource,
  onToggleViewerExpanded,
  onToggleXray,
  pickMode,
  viewerExpanded = false,
  visibleSources = [],
  xrayEnabled,
}: {
  availableSources?: readonly CadViewerSource[]
  meshMode?: boolean
  onPickModeChange: (mode: CadViewerPickMode) => void
  onSetCameraView: (view: CameraView) => void
  onToggleSource?: (source: CadViewerSource) => void
  onToggleViewerExpanded?: () => void
  onToggleXray: () => void
  pickMode: CadViewerPickMode
  viewerExpanded?: boolean
  visibleSources?: readonly CadViewerSource[]
  xrayEnabled: boolean
}) {
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-2 py-1">
      <div aria-label="Camera views" className="flex items-center gap-1">
        <span className="mr-1 text-xs font-semibold">카메라</span>
        {(['default', 'x', 'y', 'z'] as const).map((view) => (
          <button
            aria-label={`Set ${view} camera view`}
            className="min-w-7 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950"
            key={view}
            type="button"
            onClick={() => onSetCameraView(view)}
          >
            {view === 'default' ? '전체 맞춤' : `${view.toUpperCase()} 방향`}
          </button>
        ))}
      </div>

      {!meshMode ? (
        <>
          <button
            aria-label="Toggle X-ray"
            aria-pressed={xrayEnabled}
            className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
              xrayEnabled
                ? 'border-sky-400 bg-sky-50 text-sky-900'
                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800'
            }`}
            title="내부 Geometry를 보기 위한 반투명 표시"
            type="button"
            onClick={onToggleXray}
          >
            X-ray
          </button>

          <div aria-label="Viewer selection mode" className="flex items-center gap-1 border-l border-slate-200 pl-3">
            {(['off', 'geometry', 'surface'] as const).map((mode) => (
              <button
                aria-label={`Selection mode ${mode}`}
                aria-pressed={pickMode === mode}
                className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                  pickMode === mode
                    ? 'border-orange-400 bg-orange-50 text-orange-900'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800'
                }`}
                key={mode}
                type="button"
                onClick={() => onPickModeChange(mode)}
              >
                {mode === 'off' ? 'Off' : mode === 'geometry' ? 'Geometry' : 'Surface'}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {onToggleSource ? (
        <div aria-label="Viewer sources" className="flex items-center gap-1 border-l border-slate-200 pl-3">
          {(['experiment', 'task'] as const).map((source) => {
            const available = availableSources.includes(source)
            const visible = visibleSources.includes(source)
            return (
              <button
                aria-label={`Toggle ${source}`}
                aria-pressed={available && visible}
                className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                  available && visible
                    ? 'border-slate-400 bg-slate-100 text-slate-900'
                    : 'border-slate-200 bg-white text-slate-400'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                disabled={!available}
                key={source}
                type="button"
                onClick={() => onToggleSource(source)}
              >
                {source === 'experiment' ? 'Experiment' : 'Task'}
              </button>
            )
          })}
        </div>
      ) : null}

      {onToggleViewerExpanded ? (
        <button
          aria-label={viewerExpanded ? 'Viewer 영역 복원' : 'Viewer 확장'}
          aria-pressed={viewerExpanded}
          className="ml-auto flex h-8 items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950"
          title={viewerExpanded ? '좌측 및 하단 영역 복원' : '좌측 및 하단 영역 숨기기'}
          type="button"
          onClick={onToggleViewerExpanded}
        >
          {viewerExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}{' '}
          {viewerExpanded ? '영역 복원' : 'Viewer 확장'}
        </button>
      ) : null}
    </div>
  )
}
