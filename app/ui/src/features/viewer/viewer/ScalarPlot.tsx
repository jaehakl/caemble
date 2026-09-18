import { useEffect, useRef, useState } from 'react'
import type { ScalarPlotData } from './boxGridViewData'
import { heatmapEdges, heatmapPixels, heatmapTiles } from './pointCloudData'

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
  const viewportRef = useRef<HTMLDivElement>(null)
  const [nativeSize, setNativeSize] = useState(false)
  const [hover, setHover] = useState('')
  const heatmapProbe = useRef<((x: number, y: number) => string) | undefined>(undefined)
  const targets = useRef<{ x: number; y: number; label: string }[]>([])
  useEffect(() => {
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport) return
    const edges = kind === 'heatmap' ? plot.axes.map(({ ticks }) => heatmapEdges(ticks)) : []
    const uniform = edges.every((axis) =>
      axis.every(
        (edge, i) =>
          Math.abs(edge - axis[0] - ((axis[axis.length - 1] - axis[0]) * i) / (axis.length - 1)) <=
          Math.abs(axis[axis.length - 1] - axis[0]) * 1e-9,
      ),
    )
    const rgba = kind === 'heatmap' ? heatmapPixels(plot.values, range) : undefined
    const tiles =
      rgba && uniform
        ? Array.from(heatmapTiles({ width: plot.shape[1], height: plot.shape[0], rgba }, 2048), (tile) => {
            const image = document.createElement('canvas')
            image.width = tile.width
            image.height = tile.height
            image
              .getContext('2d')!
              .putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height), 0, 0)
            return { x: tile.x, y: tile.y, image }
          })
        : []
    const draw = () => {
      const width = Math.max(320, viewport.clientWidth),
        height = Math.max(220, viewport.clientHeight)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ratio = window.devicePixelRatio || 1
      canvas.width = width * ratio
      canvas.height = height * ratio
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(ratio, ratio)
      ctx.clearRect(0, 0, width, height)
      const native = kind === 'heatmap' && nativeSize
      const left = 75 - (native ? viewport.scrollLeft : 0),
        top = 25 - (native ? viewport.scrollTop : 0),
        w = native ? plot.shape[1] : width - 100,
        h = native ? plot.shape[0] : height - 90,
        right = left + w,
        bottom = top + h
      ctx.font = '12px sans-serif'
      ctx.strokeStyle = '#64748b'
      ctx.fillStyle = '#334155'
      ctx.beginPath()
      ctx.moveTo(left, top)
      ctx.lineTo(left, bottom)
      ctx.lineTo(right, bottom)
      ctx.stroke()
      targets.current = []
      heatmapProbe.current = undefined
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
          ctx.translate(left - 60, top + h / 2)
          ctx.rotate(-Math.PI / 2)
          ctx.fillText(label, 0, 0)
          ctx.restore()
        } else ctx.fillText(label, left + w / 2, bottom + 53)
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
        const normalized = edges.map((axis) => axis.map((edge) => (edge - axis[0]) / (axis[axis.length - 1] - axis[0])))
        ctx.imageSmoothingEnabled = false
        if (uniform) {
          ctx.save()
          ctx.translate(left, bottom)
          ctx.scale(w / columns, -h / rows)
          for (const tile of tiles) ctx.drawImage(tile.image, tile.x, tile.y)
          ctx.restore()
        } else {
          // Nonuniform axes retain their actual midpoint cell boundaries, without stride sampling.
          for (let row = 0; row < rows; row++)
            for (let column = 0; column < columns; column++) {
              const offset = (row * columns + column) * 4
              ctx.fillStyle = `rgb(${rgba![offset]},${rgba![offset + 1]},${rgba![offset + 2]})`
              const x = left + w * normalized[1][column],
                y = bottom - h * normalized[0][row + 1]
              ctx.fillRect(
                x,
                y,
                w * (normalized[1][column + 1] - normalized[1][column]),
                h * (normalized[0][row + 1] - normalized[0][row]),
              )
            }
        }
        heatmapProbe.current = (x, y) => {
          const coordinates = [(bottom - y) / h, (x - left) / w]
          if (coordinates.some((value) => value < 0 || value >= 1)) return ''
          const indices = normalized.map((axis, a) => {
            let lo = 0,
              hi = axis.length - 1
            while (lo + 1 < hi) {
              const mid = Math.floor((lo + hi) / 2)
              if (axis[mid] <= coordinates[a]) lo = mid
              else hi = mid
            }
            return lo
          })
          const [row, column] = indices
          return `${plot.axes[0].name}=${plot.axes[0].ticks[row]}, ${plot.axes[1].name}=${plot.axes[1].ticks[column]} · ${plot.values[row * columns + column]} ${unit ?? ''}`
        }
        axis(edges[1][0], edges[1][columns], false, `${plot.axes[1].name} (${plot.axes[1].unit ?? 'unitless'})`)
        axis(edges[0][0], edges[0][rows], true, `${plot.axes[0].name} (${plot.axes[0].unit ?? 'unitless'})`)
      }
    }
    const observer = new ResizeObserver(draw)
    observer.observe(viewport)
    viewport.addEventListener('scroll', draw)
    draw()
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', draw)
      heatmapProbe.current = undefined
      for (const tile of tiles) {
        tile.image.width = 0
        tile.image.height = 0
      }
    }
  }, [plot, kind, range, bins, unit, lockHistogramRange, nativeSize])
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
      {kind === 'heatmap' ? (
        <div className="flex shrink-0 gap-2 px-3 py-1 text-xs" aria-label="Heatmap 보기 크기">
          <button
            className="rounded border px-2 py-1 aria-pressed:bg-slate-200"
            type="button"
            aria-pressed={!nativeSize}
            onClick={() => setNativeSize(false)}
          >
            화면 맞춤
          </button>
          <button
            className="rounded border px-2 py-1 aria-pressed:bg-slate-200"
            type="button"
            aria-pressed={nativeSize}
            onClick={() => setNativeSize(true)}
          >
            원본 크기
          </button>
        </div>
      ) : null}
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto" onMouseLeave={() => setHover('')}>
        <div
          style={
            kind === 'heatmap' && nativeSize
              ? {
                  width: Math.max(320, plot.shape[1] + 100),
                  height: Math.max(220, plot.shape[0] + 90),
                  minWidth: '100%',
                  minHeight: '100%',
                }
              : { width: '100%', height: '100%' }
          }
        >
          <canvas
            ref={canvasRef}
            className="sticky top-0 left-0 block"
            role="img"
            aria-label={`${kind} 차트`}
            onMouseLeave={() => setHover('')}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect(),
                x = event.clientX - rect.left,
                y = event.clientY - rect.top
              if (kind === 'heatmap') {
                setHover(heatmapProbe.current?.(x, y) ?? '')
                return
              }
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
        </div>
      </div>
      <div role="status" className="min-h-7 px-3 text-xs text-slate-600">
        {hover ||
          (kind === 'histogram'
            ? `${plot.values.length.toLocaleString()} 표본`
            : kind === 'heatmap'
              ? `${plot.shape.join(' × ')} · 모든 원본 픽셀 표시 · 축소 시 작은 신호는 원본 크기에서 확인`
              : `${plot.shape.join(' × ')} · 최대 100,000 표본 / 200 lines 표시 · 집계 및 복사는 전체 데이터 사용`)}
      </div>
    </div>
  )
}
