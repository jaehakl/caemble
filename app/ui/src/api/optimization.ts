import { browserClient, type CaembleClient, type RequestContext } from './http'
import {
  studyDetailSchema,
  studyListSchema,
  studyTrialListSchema,
  type StudyCreateRequest,
} from '@/contracts/api/optimization'

const base = '/cae/studies'
export function createOptimizationApi(client: CaembleClient) {
  return {
    list: (options: { experimentId?: number; offset?: number; limit?: number } = {}, context?: RequestContext) => {
      const params = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(options.offset ?? 0) })
      if (options.experimentId !== undefined) params.set('experiment_id', String(options.experimentId))
      return client.request('get', `${base}?${params}`, undefined, {
        ...context,
        validate: (value) => studyListSchema.parse(value),
      })
    },
    read: (id: string, context?: RequestContext) =>
      client.request('get', `${base}/${encodeURIComponent(id)}`, undefined, {
        ...context,
        validate: (value) => studyDetailSchema.parse(value),
      }),
    trials: (id: string, offset = 0, context?: RequestContext, limit = 20) =>
      client.request('get', `${base}/${encodeURIComponent(id)}/trials?offset=${offset}&limit=${limit}`, undefined, {
        ...context,
        validate: (value) => studyTrialListSchema.parse(value),
      }),
    create: (body: StudyCreateRequest, context?: RequestContext) =>
      client.request('post', base, body, {
        ...context,
        csrf: 'required',
        validate: (value) => studyDetailSchema.parse(value),
      }),
    stop: (id: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/stop`,
        {},
        { ...context, csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
      ),
    resume: (id: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/resume`,
        {},
        { ...context, csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
      ),
    retry: (id: string, trialId: string, requestId: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/retry`,
        { request_id: requestId },
        { ...context, csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
      ),
    remove: (id: string, context?: RequestContext) =>
      client.request('delete', `${base}/${encodeURIComponent(id)}`, undefined, { ...context, csrf: 'required' }),
  }
}

export const optimizationApi = createOptimizationApi(browserClient)
