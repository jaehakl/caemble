import { browserClient, type CaembleClient, type RequestContext } from './http'
import {
  optimizationDetailSchema,
  optimizationListSchema,
  optimizationTrialListSchema,
  type OptimizationCreateRequest,
} from '@/contracts/api/optimization'

const base = '/cae/optimizations'
export function createOptimizationApi(client: CaembleClient) {
  return {
    list: (options: { experimentId?: number; offset?: number; limit?: number } = {}, context?: RequestContext) => {
      const params = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(options.offset ?? 0) })
      if (options.experimentId !== undefined) params.set('experiment_id', String(options.experimentId))
      return client.request('get', `${base}?${params}`, undefined, {
        ...context,
        validate: (value) => optimizationListSchema.parse(value),
      })
    },
    read: (id: string, context?: RequestContext) =>
      client.request('get', `${base}/${encodeURIComponent(id)}`, undefined, {
        ...context,
        validate: (value) => optimizationDetailSchema.parse(value),
      }),
    trials: (id: string, offset = 0, context?: RequestContext, limit = 20) =>
      client.request('get', `${base}/${encodeURIComponent(id)}/trials?offset=${offset}&limit=${limit}`, undefined, {
        ...context,
        validate: (value) => optimizationTrialListSchema.parse(value),
      }),
    create: (body: OptimizationCreateRequest, context?: RequestContext) =>
      client.request('post', base, body, {
        ...context,
        csrf: 'required',
        validate: (value) => optimizationDetailSchema.parse(value),
      }),
    stop: (id: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/stop`,
        {},
        { ...context, csrf: 'required', validate: (value) => optimizationDetailSchema.parse(value) },
      ),
    resume: (id: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/resume`,
        {},
        { ...context, csrf: 'required', validate: (value) => optimizationDetailSchema.parse(value) },
      ),
    retry: (id: string, trialId: string, requestId: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/retry`,
        { request_id: requestId },
        { ...context, csrf: 'required', validate: (value) => optimizationDetailSchema.parse(value) },
      ),
    retryEvaluation: (id: string, evaluationId: string, requestId: string, context?: RequestContext) =>
      client.request(
        'post',
        `${base}/${encodeURIComponent(id)}/evaluations/${encodeURIComponent(evaluationId)}/retry`,
        { request_id: requestId },
        { ...context, csrf: 'required', validate: (value) => optimizationDetailSchema.parse(value) },
      ),
    remove: (id: string, context?: RequestContext) =>
      client.request('delete', `${base}/${encodeURIComponent(id)}`, undefined, { ...context, csrf: 'required' }),
  }
}

export const optimizationApi = createOptimizationApi(browserClient)
