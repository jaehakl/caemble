import type { BuiltMeasurement } from '../../lib/cad/execution/measurement'
import type { CaeStartRequest } from './protocol'

const SHARD_BYTES = 16 * 1024 * 1024
const INLINE_CALL_PAYLOAD_BYTES = 32 * 1024

export type SerializedCaeAttachment = Readonly<{
  id: string
  name: string
  mimeType: string
  bytes: Uint8Array
}>

export function serializeCaeRequest(measurement: BuiltMeasurement) {
  const attachments: SerializedCaeAttachment[] = []
  const visit = (value: unknown, path: string): unknown => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const typedArray = value as ArrayBufferView & Readonly<{ BYTES_PER_ELEMENT: number }>
      const source = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)
      const ids: string[] = []
      for (let offset = 0; offset < source.byteLength; offset += SHARD_BYTES) {
        const id = `input-${attachments.length}`
        const bytes = source.slice(offset, offset + SHARD_BYTES)
        ids.push(id)
        attachments.push({ id, name: `${path}.${ids.length - 1}.bin`, mimeType: 'application/octet-stream', bytes })
      }
      return {
        shape: [typedArray.byteLength / typedArray.BYTES_PER_ELEMENT],
        storage: { kind: 'attachments', ids, byteLength: source.byteLength },
      }
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}.${index}`))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, `${path}.${key}`)]))
    }
    return value
  }
  const payload = visit({ measurement }, 'cae') as CaeStartRequest
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  if (payloadBytes.byteLength <= INLINE_CALL_PAYLOAD_BYTES) {
    return Object.freeze({ payload, attachments: Object.freeze(attachments) })
  }
  const ids: string[] = []
  for (let offset = 0; offset < payloadBytes.byteLength; offset += SHARD_BYTES) {
    const id = `input-${attachments.length}`
    const bytes = payloadBytes.slice(offset, offset + SHARD_BYTES)
    ids.push(id)
    attachments.push({
      id,
      name: `cae-start.${ids.length - 1}.json`,
      mimeType: 'application/json; charset=utf-8',
      bytes,
    })
  }
  return Object.freeze({
    payload: Object.freeze({
      kind: 'cae.start.payload-attachments',
      storage: Object.freeze({ kind: 'attachments', ids: Object.freeze(ids), byteLength: payloadBytes.byteLength }),
    }),
    attachments: Object.freeze(attachments),
  })
}
