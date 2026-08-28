import {
  CALCULATION_LOG_MAX_BYTES,
  CALCULATION_LOG_MAX_ENTRIES,
  CALCULATION_LOG_MAX_ENTRY_BYTES,
} from './types'

const maximumDepth = 3
const maximumEntries = 20
const encoder = new TextEncoder()

function formatValue(value: unknown, depth: number, seen: Set<object>): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`
  if (seen.has(value)) return '[Circular]'
  if (depth >= maximumDepth) return Array.isArray(value) ? '[…]' : '{…}'
  seen.add(value)
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const items = Array.from(value as unknown as ArrayLike<unknown>)
      const shown = items.slice(0, maximumEntries).map((item) => formatValue(item, depth + 1, seen))
      return `${value.constructor.name}(${items.length}) [${shown.join(', ')}${items.length > shown.length ? ', …' : ''}]`
    }
    if (Array.isArray(value)) {
      const shown = value.slice(0, maximumEntries).map((item) => formatValue(item, depth + 1, seen))
      return `[${shown.join(', ')}${value.length > shown.length ? ', …' : ''}]`
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries()).slice(0, maximumEntries)
      const shown = entries.map(
        ([key, item]) => `${formatValue(key, depth + 1, seen)} => ${formatValue(item, depth + 1, seen)}`,
      )
      return `Map(${value.size}) {${shown.join(', ')}${value.size > shown.length ? ', …' : ''}}`
    }
    if (value instanceof Set) {
      const entries = Array.from(value.values()).slice(0, maximumEntries)
      const shown = entries.map((item) => formatValue(item, depth + 1, seen))
      return `Set(${value.size}) {${shown.join(', ')}${value.size > shown.length ? ', …' : ''}}`
    }
    const entries = Object.entries(value).slice(0, maximumEntries)
    const shown = entries.map(([key, item]) => `${key}: ${formatValue(item, depth + 1, seen)}`)
    const suffix = Object.keys(value).length > entries.length ? ', …' : ''
    return `{${shown.join(', ')}${suffix}}`
  } catch {
    return '[Unformattable]'
  } finally {
    seen.delete(value)
  }
}

function truncateUtf8(value: string, maximumBytes: number) {
  if (encoder.encode(value).byteLength <= maximumBytes) return value
  let end = Math.min(value.length, maximumBytes)
  while (end > 0 && encoder.encode(`${value.slice(0, end)}…`).byteLength > maximumBytes) end -= 1
  return `${value.slice(0, end)}…`
}

export function createCalculationConsole(emit: (message: string) => void) {
  let byteLength = 0
  let count = 0
  let warned = false
  const warn = () => {
    if (warned) return
    warned = true
    emit('[Calculation console.log output truncated]')
  }
  return Object.freeze({
    log: (...values: unknown[]) => {
      if (count >= CALCULATION_LOG_MAX_ENTRIES) {
        warn()
        return
      }
      const message = truncateUtf8(
        values.map((value) => formatValue(value, 0, new Set())).join(' '),
        CALCULATION_LOG_MAX_ENTRY_BYTES,
      )
      const messageBytes = encoder.encode(message).byteLength
      if (byteLength + messageBytes > CALCULATION_LOG_MAX_BYTES) {
        warn()
        return
      }
      count += 1
      byteLength += messageBytes
      emit(message)
    },
  })
}
