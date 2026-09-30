import { browserClient, type RequestContext } from './http'
import {
  studyDetailSchema,
  studyListSchema,
  studyTrialListSchema,
  type StudyCreateRequest,
} from '@/contracts/api/optimization'

const base = '/cae/studies'
export const optimizationApi = {
  list: (options: { experimentId?: number; offset?: number; limit?: number } = {}, context?: RequestContext) => {
    const params = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(options.offset ?? 0) })
    if (options.experimentId !== undefined) params.set('experiment_id', String(options.experimentId))
    return browserClient.request('get', `${base}?${params}`, undefined, {
      ...context,
      validate: (value) => studyListSchema.parse(value),
    })
  },
  read: (id: string, context?: RequestContext) =>
    browserClient.request('get', `${base}/${encodeURIComponent(id)}`, undefined, {
      ...context,
      validate: (value) => studyDetailSchema.parse(value),
    }),
  trials: (id: string, offset = 0, context?: RequestContext) =>
    browserClient.request('get', `${base}/${encodeURIComponent(id)}/trials?offset=${offset}&limit=20`, undefined, {
      ...context,
      validate: (value) => studyTrialListSchema.parse(value),
    }),
  create: (body: StudyCreateRequest) =>
    browserClient.request('post', base, body, {
      csrf: 'required',
      validate: (value) => studyDetailSchema.parse(value),
    }),
  stop: (id: string) =>
    browserClient.request(
      'post',
      `${base}/${encodeURIComponent(id)}/stop`,
      {},
      { csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
    ),
  resume: (id: string) =>
    browserClient.request(
      'post',
      `${base}/${encodeURIComponent(id)}/resume`,
      {},
      { csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
    ),
  retry: (id: string, trialId: string, requestId: string) =>
    browserClient.request(
      'post',
      `${base}/${encodeURIComponent(id)}/trials/${encodeURIComponent(trialId)}/retry`,
      { request_id: requestId },
      { csrf: 'required', validate: (value) => studyDetailSchema.parse(value) },
    ),
  remove: (id: string) =>
    browserClient.request('delete', `${base}/${encodeURIComponent(id)}`, undefined, { csrf: 'required' }),
}
