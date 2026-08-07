import type { BuiltSample, BuiltSetup } from '../../lib/cad'
import type { CaeStartRequest } from './protocol'
import { CaeSimulationError } from './errors'

const INPUT_LIMIT_BYTES = 256 * 1024 * 1024
const SHARD_BYTES = 16 * 1024 * 1024
const INLINE_CALL_PAYLOAD_BYTES = 512 * 1024
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

export type SerializedCaeAttachment = Readonly<{
  id: string
  name: string
  mimeType: string
  bytes: Uint8Array
}>

export function serializeCaeRequest(sample: BuiltSample, setup: BuiltSetup) {
  const attachments: SerializedCaeAttachment[] = []
  let totalBytes = 0
  const visit = (value: unknown, path: string): unknown => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      if (!LITTLE_ENDIAN) {
        throw new CaeSimulationError(
          'unsupported_platform',
          'CAE raw tensor 전송은 little-endian browser가 필요합니다.',
        )
      }
      const typedArray = value as ArrayBufferView & Readonly<{ BYTES_PER_ELEMENT: number }>
      const source = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)
      const ids: string[] = []
      for (let offset = 0; offset < source.byteLength; offset += SHARD_BYTES) {
        const id = `input-${attachments.length}`
        const bytes = source.slice(offset, Math.min(offset + SHARD_BYTES, source.byteLength))
        ids.push(id)
        attachments.push({
          id,
          name: `${path}.${ids.length - 1}.bin`,
          mimeType: 'application/octet-stream',
          bytes,
        })
      }
      totalBytes += source.byteLength
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
  const payload = visit({ sample, setup }, 'cae') as CaeStartRequest
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  totalBytes += payloadBytes.byteLength
  if (totalBytes > INPUT_LIMIT_BYTES) {
    throw new CaeSimulationError('resource_limit', 'BuiltSample/BuiltSetup이 256 MiB를 초과했습니다.')
  }
  if (payloadBytes.byteLength > INLINE_CALL_PAYLOAD_BYTES) {
    const ids: string[] = []
    for (let offset = 0; offset < payloadBytes.byteLength; offset += SHARD_BYTES) {
      const id = `input-${attachments.length}`
      const bytes = payloadBytes.slice(offset, Math.min(offset + SHARD_BYTES, payloadBytes.byteLength))
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
        storage: Object.freeze({
          kind: 'attachments',
          ids: Object.freeze(ids),
          byteLength: payloadBytes.byteLength,
        }),
      }),
      attachments: Object.freeze(attachments),
    })
  }
  return Object.freeze({ payload, attachments: Object.freeze(attachments) })
}
