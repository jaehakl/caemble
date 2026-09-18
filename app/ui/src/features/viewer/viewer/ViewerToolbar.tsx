import { Box, MousePointer2, Scan, ScanFace, ScanLine, FlaskConical, ListTodo } from 'lucide-react'
import type { CadViewerPickMode, CadViewerSource } from './model'
import { ViewerAxisIcon, ViewerToolButton } from './ViewerTools'

export type CameraView = 'default' | 'x' | 'y' | 'z'

export function ViewerToolbar({
  availableSources = [],
  meshMode = false,
  onPickModeChange,
  onSetCameraView,
  onToggleSource,
  onToggleXray,
  pickMode,
  visibleSources = [],
  xrayEnabled,
}: {
  availableSources?: readonly CadViewerSource[]
  meshMode?: boolean
  onPickModeChange: (mode: CadViewerPickMode) => void
  onSetCameraView: (view: CameraView) => void
  onToggleSource?: (source: CadViewerSource) => void
  onToggleXray: () => void
  pickMode: CadViewerPickMode
  visibleSources?: readonly CadViewerSource[]
  xrayEnabled: boolean
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div aria-label="Camera views" className="flex items-center gap-1">
        {(['default', 'x', 'y', 'z'] as const).map((view) => (
          <ViewerToolButton
            key={view}
            label={view === 'default' ? '전체 맞춤' : `${view.toUpperCase()} 방향`}
            aria-label={`Set ${view} camera view`}
            onClick={() => onSetCameraView(view)}
          >
            {view === 'default' ? <Scan /> : <ViewerAxisIcon axis={view.toUpperCase()} />}
          </ViewerToolButton>
        ))}
      </div>
      <ViewerToolButton
        label="X-ray"
        aria-label="Toggle X-ray"
        active={xrayEnabled}
        disabled={meshMode}
        title={meshMode ? 'Geometry가 없어 X-ray를 사용할 수 없습니다.' : '내부 Geometry를 보기 위한 반투명 표시'}
        onClick={onToggleXray}
      >
        <ScanLine />
      </ViewerToolButton>
      <div aria-label="Viewer selection mode" className="flex items-center gap-1 border-l pl-1">
        {(['off', 'geometry', 'surface'] as const).map((mode) => (
          <ViewerToolButton
            key={mode}
            label={mode === 'off' ? 'Off' : mode === 'geometry' ? 'Geometry' : 'Surface'}
            aria-label={`Selection mode ${mode}`}
            active={pickMode === mode}
            disabled={meshMode}
            onClick={() => onPickModeChange(mode)}
          >
            {mode === 'off' ? <MousePointer2 /> : mode === 'geometry' ? <Box /> : <ScanFace />}
          </ViewerToolButton>
        ))}
      </div>
      <div aria-label="Viewer sources" className="flex items-center gap-1 border-l pl-1">
        {(['experiment', 'task'] as const).map((source) => (
          <ViewerToolButton
            key={source}
            label={`display ${source === 'experiment' ? 'Experiment' : 'Task'}`}
            aria-label={`Toggle ${source}`}
            active={availableSources.includes(source) && visibleSources.includes(source)}
            disabled={!onToggleSource || !availableSources.includes(source)}
            title={!availableSources.includes(source) ? `${source} Geometry가 없습니다.` : `${source} 표시 전환`}
            onClick={() => onToggleSource?.(source)}
          >
            {source === 'experiment' ? <FlaskConical /> : <ListTodo />}
          </ViewerToolButton>
        ))}
      </div>
    </div>
  )
}
