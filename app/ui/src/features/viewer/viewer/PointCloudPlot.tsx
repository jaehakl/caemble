import { useMemo, useState } from 'react'
import JscadViewer from './JscadViewer'
import { createPointCloudData } from './pointCloudData'
import type { ScalarPlotData } from './boxGridViewData'
const emptyLayers = Object.freeze([])
export function PointCloudPlot({
  plot,
  onRenderEnd,
  onRenderError,
}: {
  plot: ScalarPlotData
  onRenderEnd?: () => void
  onRenderError?: (message: string) => void
}) {
  const [error, setError] = useState('')
  const data = useMemo(() => createPointCloudData(plot, { identity: JSON.stringify(plot.axes) }), [plot])
  return (
    <div className="flex h-full min-h-0 flex-col" data-result-visualization="point-cloud">
      <div className="flex flex-wrap gap-4 p-2 text-xs">
        {plot.axes.map((axis) => (
          <span key={axis.name}>
            {axis.name}: {axis.ticks[0]} ~ {axis.ticks[axis.ticks.length - 1]} {axis.unit}
          </span>
        ))}
        <span className="flex items-center gap-2" aria-label="값 범례">
          {Number(plot.range[0].toPrecision(6))}
          <span className="h-3 w-24" style={{ background: 'linear-gradient(to right, blue, lime, red)' }} />
          {Number(plot.range[1].toPrecision(6))}
        </span>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="min-h-0 flex-1">
        <JscadViewer
          layers={emptyLayers}
          lengthUnit="m"
          showScaleBar={false}
          heatmapRenderData={data}
          onRenderStart={() => {}}
          onRenderEnd={() => onRenderEnd?.()}
          onRenderError={(message) => {
            setError(message)
            onRenderError?.(message)
          }}
        />
      </div>
    </div>
  )
}
