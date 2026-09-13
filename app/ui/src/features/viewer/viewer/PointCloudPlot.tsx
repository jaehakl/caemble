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
        <span>
          {data.displayedCount.toLocaleString()} / {plot.values.length.toLocaleString()} 표본 표시 · 0값{' '}
          {data.hiddenZeroCount.toLocaleString()}개 숨김
        </span>
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
      <PlotProbe plot={plot} />
    </div>
  )
}
export function PlotProbe({ plot }: { plot: ScalarPlotData }) {
  const [indices, setIndices] = useState<number[]>([])
  const safe = plot.shape.map((length, axis) => Math.min(length - 1, indices[axis] ?? 0))
  const flat = safe.reduce((offset, index, axis) => offset * plot.shape[axis] + index, 0)
  return (
    <div className="flex flex-wrap items-center gap-3 border-t p-2 text-xs" aria-label="표본 조회">
      <span className="font-semibold">표본 조회</span>
      {plot.axes.map((axis, i) => (
        <label key={i}>
          {axis.name}{' '}
          <input
            className="w-16 rounded border p-1"
            aria-label={`${axis.name} 조회 index`}
            type="number"
            min={0}
            max={plot.shape[i] - 1}
            value={safe[i]}
            onChange={(event) => {
              const next = [...safe]
              next[i] = Math.max(0, Math.min(plot.shape[i] - 1, Math.trunc(Number(event.target.value) || 0)))
              setIndices(next)
            }}
          />{' '}
          = {axis.ticks[safe[i]]} {axis.unit}
        </label>
      ))}
      <output>값: {plot.values[flat]}</output>
    </div>
  )
}
