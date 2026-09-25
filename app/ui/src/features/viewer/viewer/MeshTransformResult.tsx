import { ViewerDiagnostic } from './ViewerDiagnostics'
import { ViewerLayout } from './ViewerTools'
import { useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { ViewerSceneOnly } from './ViewerSceneLayers'
import { useViewerComparison, useViewerSetting } from './comparisonSettings'
import { MeshPlayback } from './MeshPlayback'
import { meshFrameAtTime } from './meshDeformation'
import { createMeshTransformRenderData, prepareMeshTransform, type RecordedMeshTransform } from './meshTransforms'
import type { MeshRenderData } from './meshFields'
import type { UcumUnit } from '@/lib/cad/model'

export function MeshTransformResult({
  motion,
  displayUnit = motion.lengthUnit,
  renderViewer,
}: {
  motion: RecordedMeshTransform
  displayUnit?: UcumUnit
  renderViewer: (data: MeshRenderData) => ReactNode
}) {
  const comparison = useViewerComparison()
  const sceneOnly = useContext(ViewerSceneOnly)
  const [selectedTime, setTime] = useViewerSetting(
    'meshTransform.time',
    motion.times[0],
    'item',
    (value) => value >= motion.times[0] && value <= motion.times[motion.times.length - 1],
  )
  const minimum = motion.times[0]
  const maximum = motion.times[motion.times.length - 1]
  const time = comparison ? selectedTime : Math.max(minimum, Math.min(maximum, selectedTime))
  useEffect(() => {
    if (!comparison) setTime(time)
  }, [comparison, setTime, time])
  const prepared = useMemo(() => prepareMeshTransform(motion, displayUnit), [motion, displayUnit])
  const rendered = useMemo(() => {
    if (!Number.isFinite(time) || time < minimum || time > maximum)
      return { error: '선택한 시각이 현재 결과에 없습니다. 재생 시각을 조정하세요.', data: null }
    return { error: null, data: createMeshTransformRenderData(motion, time, prepared) }
  }, [motion, time, prepared, minimum, maximum])
  const selectFrame = useCallback((frame: number) => setTime(motion.times[frame]), [motion.times, setTime])
  return (
    <ViewerLayout>
      <article
        className={sceneOnly ? 'contents' : 'flex h-full min-h-0 flex-col overflow-hidden bg-white'}
        data-result-visualization="mesh transform"
        aria-label={`${motion.label} mesh transform`}
      >
        {!sceneOnly ? (
          <h3 className="px-2 pt-2 text-sm font-semibold text-slate-900">
            {motion.label.startsWith('@visualizations.') ? motion.label.slice('@visualizations.'.length) : motion.label}
          </h3>
        ) : null}
        {!sceneOnly ? (
          <p className="px-2 text-xs text-slate-500">
            {motion.bodyIds.length} bodies · 실제 크기 1× · {displayUnit}
          </p>
        ) : null}
        <MeshPlayback
          name={motion.label}
          times={motion.times}
          unit="s"
          frame={meshFrameAtTime(motion.times, time)}
          onFrame={selectFrame}
          time={time}
          onTime={setTime}
        />
        {rendered.error ? (
          <ViewerDiagnostic level="warning" message={rendered.error} />
        ) : null}
        {rendered.data ? (
          <div className={sceneOnly ? 'contents' : 'min-h-0 flex-1 overflow-hidden'}>{renderViewer(rendered.data)}</div>
        ) : null}
        {!sceneOnly ? (
          <div className="flex shrink-0 flex-wrap gap-3 border-t p-2 text-xs text-slate-600">
            {motion.bodyIds.map((id, index) => (
              <span className="flex min-w-0 items-center gap-1" key={id} title={id}>
                <span className="size-3 shrink-0 rounded-sm" style={{ background: prepared.bodyColors[index] }} />
                <span className="max-w-56 truncate">{id}</span>
              </span>
            ))}
          </div>
        ) : null}
      </article>
    </ViewerLayout>
  )
}
