import type {
  RuntimeActivityDetails,
  RuntimeActivityDraft,
  RuntimeActivityEvent,
  RuntimeActivityLevel,
  RuntimeActivitySource,
} from './types'

export const RUNTIME_CONSOLE_MAX_EVENTS = 500
export const RUNTIME_CONSOLE_MAX_BYTES = 256 * 1024

const maxMessageLength = 4096
const maxDetailEntries = 64
const maxDetailKeyLength = 80
const maxDetailStringLength = 1024
const maxIdentifierLength = 256
const redacted = '[REDACTED]'
const sensitiveKey = /authorization|cookie|credential|password|passphrase|secret|token|api[-_ ]?key/iu
const sources = new Set<RuntimeActivitySource>(['cad', 'gpstation', 'cae'])
const levels = new Set<RuntimeActivityLevel>(['info', 'warning', 'error'])
const encoder = new TextEncoder()

export type RuntimeConsoleSnapshot = Readonly<{
  events: readonly RuntimeActivityEvent[]
  byteLength: number
}>

export type RuntimeConsoleStore = Readonly<{
  append: (activity: RuntimeActivityDraft) => RuntimeActivityEvent
  clear: () => void
  getSnapshot: () => RuntimeConsoleSnapshot
  subscribe: (listener: () => void) => () => void
}>

type StoreDependencies = Readonly<{
  createId?: () => string
  now?: () => number
}>

function boundedString(value: unknown, maximum: number) {
  return String(value ?? '').slice(0, maximum)
}

function safeDetails(value: unknown): RuntimeActivityDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const details: Record<string, string | number | boolean | null> = {}
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, maxDetailEntries)) {
    const key = boundedString(rawKey, maxDetailKeyLength)
    if (!key) continue
    if (sensitiveKey.test(key)) {
      details[key] = redacted
      continue
    }
    if (rawValue === null || typeof rawValue === 'boolean') details[key] = rawValue
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) details[key] = rawValue
    else if (typeof rawValue === 'string') details[key] = boundedString(rawValue, maxDetailStringLength)
  }
  return Object.keys(details).length ? Object.freeze(details) : undefined
}

function eventByteLength(event: RuntimeActivityEvent) {
  return encoder.encode(JSON.stringify(event)).byteLength
}

export function createRuntimeConsoleStore(dependencies: StoreDependencies = {}): RuntimeConsoleStore {
  const listeners = new Set<() => void>()
  let sequence = 0
  let sizes: number[] = []
  let snapshot: RuntimeConsoleSnapshot = Object.freeze({ events: Object.freeze([]), byteLength: 0 })
  const now = dependencies.now ?? Date.now
  const createId = dependencies.createId ?? (() => `runtime-${now()}-${++sequence}`)

  const publish = (events: readonly RuntimeActivityEvent[], byteLength: number) => {
    snapshot = Object.freeze({ events: Object.freeze(events), byteLength })
    listeners.forEach((listener) => listener())
  }

  const append = (activity: RuntimeActivityDraft) => {
    const timestamp =
      typeof activity.timestamp === 'number' && Number.isFinite(activity.timestamp) ? activity.timestamp : now()
    const progress =
      typeof activity.progress === 'number' && Number.isFinite(activity.progress)
        ? Math.min(1, Math.max(0, activity.progress))
        : undefined
    const details = safeDetails(activity.details)
    const event: RuntimeActivityEvent = Object.freeze({
      id: boundedString(activity.id, maxIdentifierLength) || boundedString(createId(), maxIdentifierLength),
      timestamp,
      source: sources.has(activity.source) ? activity.source : 'cad',
      level: levels.has(activity.level) ? activity.level : 'info',
      ...(activity.phase ? { phase: boundedString(activity.phase, maxIdentifierLength) } : {}),
      message: boundedString(activity.message, maxMessageLength) || 'Runtime activity',
      ...(activity.jobId ? { jobId: boundedString(activity.jobId, maxIdentifierLength) } : {}),
      ...(activity.runId ? { runId: boundedString(activity.runId, maxIdentifierLength) } : {}),
      ...(progress === undefined ? {} : { progress }),
      ...(details ? { details } : {}),
    })
    const nextEvents = [...snapshot.events, event]
    sizes = [...sizes, eventByteLength(event)]
    let byteLength = sizes.reduce((total, size) => total + size, 0)
    while (nextEvents.length > RUNTIME_CONSOLE_MAX_EVENTS || byteLength > RUNTIME_CONSOLE_MAX_BYTES) {
      nextEvents.shift()
      byteLength -= sizes.shift() ?? 0
    }
    publish(nextEvents, byteLength)
    return event
  }

  const clear = () => {
    if (!snapshot.events.length) return
    sizes = []
    publish([], 0)
  }

  return Object.freeze({
    append,
    clear,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
}
