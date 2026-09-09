import { API_URL, browserClient, type CaembleClient, type RequestContext } from './http'
import {
  caeBatchListSchema,
  caeBatchSchema,
  caeEventSchema,
  type CaeBatchRequest,
  type CaeEvent,
} from '@/contracts/api/cae'

export function createCaeBatches(client: CaembleClient) {
  const { request } = client
  return {
    create: (body: CaeBatchRequest) =>
      request('post', '/cae/batches', body, { csrf: 'required', validate: (value) => caeBatchSchema.parse(value) }),
    uploadChunk: (id: string, index: number, chunk: number, bytes: Uint8Array, hash: string, signal?: AbortSignal) =>
      request('put', `/cae/batches/${encodeURIComponent(id)}/items/${index}/chunks/${chunk}`, undefined, {
        csrf: 'required',
        rawBody: bytes,
        headers: { 'X-Chunk-SHA256': hash },
        signal,
      }),
    finalize: (id: string, index: number, signal?: AbortSignal, body: unknown = {}) =>
      request('post', `/cae/batches/${encodeURIComponent(id)}/items/${index}/finalize`, body, {
        csrf: 'required',
        signal,
      }),
    commit: (id: string, signal?: AbortSignal) =>
      request(
        'post',
        `/cae/batches/${encodeURIComponent(id)}/commit`,
        {},
        { csrf: 'required', signal, validate: (value) => caeBatchSchema.parse(value) },
      ),
    list: (
      options: Readonly<{ experimentId?: number; offset?: number; limit?: number }> = {},
      context?: RequestContext,
    ) => {
      const params = new URLSearchParams({ limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) })
      if (options.experimentId !== undefined) params.set('experiment_id', String(options.experimentId))
      return request('get', `/cae/batches?${params}`, undefined, {
        ...context,
        validate: (value) => caeBatchListSchema.parse(value),
      })
    },
    read: (id: string, options: Readonly<{ offset?: number; limit?: number }> = {}, context?: RequestContext) =>
      request(
        'get',
        `/cae/batches/${encodeURIComponent(id)}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`,
        undefined,
        { ...context, validate: (value) => caeBatchSchema.parse(value) },
      ),
    cancel: (id: string) =>
      request(
        'post',
        `/cae/batches/${encodeURIComponent(id)}/cancel`,
        {},
        { csrf: 'required', validate: (value) => caeBatchSchema.parse(value) },
      ),
    retry: (id: string, jobIds?: readonly string[]) =>
      request('post', `/cae/batches/${encodeURIComponent(id)}/retry`, jobIds ? { job_ids: jobIds } : {}, {
        csrf: 'required',
        validate: (value) => caeBatchSchema.parse(value),
      }),
    markRead: (id: string, eventId: number) =>
      request('post', `/cae/batches/${encodeURIComponent(id)}/read`, { event_id: eventId }, { csrf: 'required' }),
  }
}
export const caeBatches = createCaeBatches(browserClient)

export function subscribeCaeEvents(
  after: number,
  onEvent: (event: CaeEvent) => void,
  onConnection: (connected: boolean) => void,
) {
  const source = new EventSource(`${API_URL}/cae/events?after=${after}`, { withCredentials: true })
  source.onopen = () => onConnection(true)
  source.onerror = () => onConnection(false)
  source.onmessage = (message) => {
    try {
      onEvent(caeEventSchema.parse(JSON.parse(message.data)))
    } catch {
      onConnection(false)
      source.close()
    }
  }
  return () => source.close()
}
