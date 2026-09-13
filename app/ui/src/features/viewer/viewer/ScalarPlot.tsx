import { useEffect, useRef, useState } from 'react'
import type { ScalarPlotData } from './boxGridViewData'
import { plotColor } from './pointCloudData'

export function buildPlotHistogram(values: readonly number[], count?: number, domain?: readonly number[]) {
  let min = domain?.[0] ?? Infinity,
    max = domain?.[1] ?? -Infinity
  if (!domain)
    for (const value of values) {
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  if (!values.length) return []
  const bins = Math.max(1, Math.min(100, Math.trunc(count ?? Math.ceil(Math.sqrt(values.length)))))
  const actual = min === max ? 1 : bins
  const result = Array.from({ length: actual }, (_, i) => ({
    min: min + ((max - min) * i) / actual,
    max: min + ((max - min) * (i + 1)) / actual,
    count: 0,
  }))
  for (const value of values)
    result[min === max ? 0 : Math.max(0, Math.min(actual - 1, Math.floor(((value - min) / (max - min)) * actual)))]
      .count++
  return result
}

export function ScalarPlot({
  plot,
  kind,
  range = plot.range,
  bins,
  unit,
  lockHistogramRange = false,
}: {
  plot: ScalarPlotData
  kind: 'histogram' | 'line' | 'heatmap'
  range?: readonly number[]
  bins?: number
  unit?: string
  lockHistogramRange?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState('')
  const targets = useRef<{ x: number; y: number; label: string }[]>([])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const width = Math.max(320, canvas.clientWidth),
        height = Math.max(220, canvas.clientHeight)
      const ratio = window.devicePixelRatio || 1
      canvas.width = width * ratio
      canvas.height = height * ratio
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(ratio, ratio)
      ctx.clearRect(0, 0, width, height)
      const left = 75,
        top = 25,
        right = width - 25,
        bottom = height - 65
      const w = right - left,
        h = bottom - top
      ctx.font = '12px sans-serif'
      ctx.strokeStyle = '#64748b'
      ctx.fillStyle = '#334155'
      ctx.beginPath()
      ctx.moveTo(left, top)
      ctx.lineTo(left, bottom)
      ctx.lineTo(right, bottom)
      ctx.stroke()
      targets.current = []
      const tickText = (value: number) => Number(value.toPrecision(4)).toString()
      const axis = (min: number, max: number, vertical: boolean, label: string) => {
        ctx.fillStyle = '#334155'
        ctx.textAlign = vertical ? 'right' : 'center'
        for (let i = 0; i <= 4; i++) {
          const t = i / 4
          ctx.fillText(
            tickText(min + (max - min) * t),
            vertical ? left - 8 : left + w * t,
            vertical ? bottom - h * t : bottom + 20,
          )
        }
        ctx.textAlign = 'center'
        if (vertical) {
          ctx.save()
          ctx.translate(15, top + h / 2)
          ctx.rotate(-Math.PI / 2)
          ctx.fillText(label, 0, 0)
          ctx.restore()
        } else ctx.fillText(label, left + w / 2, height - 12)
      }
      if (kind === 'histogram') {
        const histogram = buildPlotHistogram(plot.values, bins, range)
        const maximum = lockHistogramRange
          ? plot.values.length
          : histogram.reduce((max, bin) => Math.max(max, bin.count), 1)
        histogram.forEach((bin, i) => {
          const x = left + (w * i) / histogram.length,
            bar = (h * bin.count) / maximum
          ctx.fillStyle = '#0284c7'
          ctx.fillRect(x + 1, bottom - bar, Math.max(1, w / histogram.length - 2), bar)
          targets.current.push({
            x: x + w / histogram.length / 2,
            y: bottom - bar,
            label: `${tickText(bin.min)} ~ ${tickText(bin.max)} ${unit ?? ''} · ${bin.count} 표본`,
          })
        })
        axis(range[0], range[1], false, `값 (${unit ?? 'unitless'})`)
        axis(0, maximum, true, '빈도')
      } else if (kind === 'line') {
        const main = plot.axes[1],
          sub = plot.axes[0],
          columns = plot.shape[1]
        const min = range[0],
          max = range[1]
        const seriesStride = Math.max(1, Math.ceil(sub.ticks.length / 200))
        const sampleStride = Math.max(1, Math.ceil((columns * Math.ceil(sub.ticks.length / seriesStride)) / 100_000))
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, top, w, h)
        ctx.clip()
        for (let row = 0; row < sub.ticks.length; row += seriesStride) {
          ctx.strokeStyle = `hsl(${(row * 137.5) % 360} 65% 42%)`
          ctx.fillStyle = ctx.strokeStyle
          ctx.beginPath()
          const selected = Array.from({ length: Math.ceil(columns / sampleStride) }, (_, i) => i * sampleStride)
          if (selected[selected.length - 1] !== columns - 1) selected.push(columns - 1)
          selected.forEach((column, index) => {
            const value = plot.values[row * columns + column]
            const x =
              left +
              w *
                (main.ticks[columns - 1] === main.ticks[0]
                  ? 0.5
                  : (main.ticks[column] - main.ticks[0]) / (main.ticks[columns - 1] - main.ticks[0]))
            const y = bottom - h * (min === max ? 0.5 : (value - min) / (max - min))
            if (!index) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
            if (columns === 1) ctx.fillRect(x - 3, y - 3, 6, 6)
            targets.current.push({
              x,
              y,
              label: `${sub.name}=${sub.ticks[row]} ${sub.unit ?? ''}, ${main.name}=${main.ticks[column]} ${main.unit ?? ''} · ${value} ${unit ?? ''}`,
            })
          })
          ctx.stroke()
        }
        ctx.restore()
        axis(main.ticks[0], main.ticks[columns - 1], false, `${main.name} (${main.unit ?? 'unitless'})`)
        axis(min, max, true, `값 (${unit ?? 'unitless'})`)
      } else {
        const rows = plot.shape[0],
          columns = plot.shape[1]
        const edges = plot.axes.map(({ ticks }) => {
          if (ticks.length === 1) return [ticks[0] - 0.5, ticks[0] + 0.5]
          return [
            ticks[0] - (ticks[1] - ticks[0]) / 2,
            ...ticks.slice(1).map((tick, i) => (ticks[i] + tick) / 2),
            ticks[ticks.length - 1] + (ticks[ticks.length - 1] - ticks[ticks.length - 2]) / 2,
          ]
        })
        const xSpan = edges[1][columns] - edges[1][0],
          ySpan = edges[0][rows] - edges[0][0]
        const rowStride = Math.max(1, Math.ceil(rows / 500)),
          columnStride = Math.max(1, Math.ceil((columns * Math.ceil(rows / rowStride)) / 100_000))
        for (let row = 0; row < rows; row += rowStride)
          for (let column = 0; column < columns; column += columnStride) {
            const color = plotColor(plot.values[row * columns + column], range)
            ctx.fillStyle = `rgb(${color
              .slice(0, 3)
              .map((c) => c * 255)
              .join(',')})`
            const x = left + (w * (edges[1][column] - edges[1][0])) / xSpan,
              y = bottom - (h * (edges[0][Math.min(rows, row + rowStride)] - edges[0][0])) / ySpan
            const cellWidth = (w * (edges[1][Math.min(columns, column + columnStride)] - edges[1][column])) / xSpan
            const cellHeight = (h * (edges[0][Math.min(rows, row + rowStride)] - edges[0][row])) / ySpan
            ctx.fillRect(x, y, cellWidth + 0.5, cellHeight + 0.5)
            targets.current.push({
              x: x + cellWidth / 2,
              y: y + cellHeight / 2,
              label: `${plot.axes[0].name}=${plot.axes[0].ticks[row]}, ${plot.axes[1].name}=${plot.axes[1].ticks[column]} · ${plot.values[row * columns + column]} ${unit ?? ''}`,
            })
          }
        axis(edges[1][0], edges[1][columns], false, `${plot.axes[1].name} (${plot.axes[1].unit ?? 'unitless'})`)
        axis(edges[0][0], edges[0][rows], true, `${plot.axes[0].name} (${plot.axes[0].unit ?? 'unitless'})`)
      }
    }
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [plot, kind, range, bins, unit, lockHistogramRange])
  return (
    <div className="flex h-full min-h-0 flex-col" data-result-visualization={kind}>
      {kind === 'line' ? (
        <div
          className="flex max-h-16 shrink-0 flex-wrap gap-x-4 gap-y-1 overflow-auto px-3 py-1 text-xs"
          aria-label="Line 범례"
        >
          {plot.axes[0].ticks.map((tick, row) =>
            row % Math.max(1, Math.ceil(plot.shape[0] / 200)) === 0 ? (
              <span key={row} className="flex items-center gap-1">
                <span className="h-0.5 w-4" style={{ background: `hsl(${(row * 137.5) % 360} 65% 42%)` }} />
                {plot.axes[0].name}={Number(tick.toPrecision(5))} {plot.axes[0].unit}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label={`${kind} 차트`}
        onMouseLeave={() => setHover('')}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect(),
            x = event.clientX - rect.left,
            y = event.clientY - rect.top
          let nearest: (typeof targets.current)[number] | undefined,
            distance = Infinity
          for (const target of targets.current) {
            const delta = (target.x - x) ** 2 + (target.y - y) ** 2
            if (delta < distance) {
              nearest = target
              distance = delta
            }
          }
          setHover(nearest?.label ?? '')
        }}
      />
      <div role="status" className="min-h-7 px-3 text-xs text-slate-600">
        {hover ||
          (kind === 'histogram'
            ? `${plot.values.length.toLocaleString()} 표본`
            : `${plot.shape.join(' × ')} · 최대 100,000 표본${kind === 'line' ? ' / 200 lines' : ''} 표시 · 집계 및 복사는 전체 데이터 사용`)}
      </div>
    </div>
  )
}
