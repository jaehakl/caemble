import type { GeometryMode } from './viewerDisplay'
import { Box, MousePointer2, Scan, ScanFace, ListTodo } from 'lucide-react'
import type { CadViewerPickMode, CadViewerSource } from './model'
import { GeometryDisplayButton, ViewerAxisIcon, ViewerToolButton } from './ViewerTools'

export type CameraView = 'default' | 'x' | 'y' | 'z'

export function ViewerToolbar({
  geometryMode,
  onGeometryModeChange,
  availableSources = [],
  meshMode = false,
  onPickModeChange,
  onSetCameraView,
  onToggleSource,
  pickMode,
  visibleSources = [],
}: {
  geometryMode?: GeometryMode
  onGeometryModeChange?: (mode: GeometryMode) => void
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
      {geometryMode !== undefined && onGeometryModeChange ? (
        <GeometryDisplayButton mode={geometryMode} onChange={onGeometryModeChange} />
      ) : null}
      <div aria-label="Viewer sources" className="flex items-center gap-1 border-l pl-1">
        {(['task'] as const).map((source) => (
          <ViewerToolButton
            key={source}
            label="display Task"
            aria-label={`Toggle ${source}`}
            active={availableSources.includes(source) && visibleSources.includes(source)}
            disabled={!onToggleSource || !availableSources.includes(source)}
            title={!availableSources.includes(source) ? `${source} Geometry가 없습니다.` : `${source} 표시 전환`}
            onClick={() => onToggleSource?.(source)}
          >
            <ListTodo />
          </ViewerToolButton>
        ))}
      </div>
    </div>
  )
}
