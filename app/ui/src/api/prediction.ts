import { z } from 'zod'
import { browserClient, type CaembleClient, type RequestContext } from './http'
import {
  predictionDatasetSchema,
  predictionGrantSchema,
  predictionModelSchema,
  type PredictionDatasetSelection,
  type PredictionModelReservation,
} from '@/contracts/api/prediction'

export function createPredictionApi(client: CaembleClient) {
  return {
    datasets: (experimentId: number, context?: RequestContext) =>
      client.request('get', `/prediction/datasets?experiment_id=${experimentId}`, undefined, {
        ...context,
        validate: (value) => z.object({ items: z.array(predictionDatasetSchema) }).parse(value).items,
      }),
    createDataset: (body: PredictionDatasetSelection, context?: RequestContext) =>
      client.request('post', '/prediction/datasets', body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionDatasetSchema.parse(value),
      }),
    syncDataset: (id: string, body: PredictionDatasetSelection, context?: RequestContext) =>
      client.request('post', `/prediction/datasets/${encodeURIComponent(id)}/sync`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionDatasetSchema.parse(value),
      }),
    registerDataset: (body: object, context?: RequestContext) =>
      client.request('post', '/prediction/datasets/local', body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionDatasetSchema.parse(value),
      }),
    grant: (id: string, revision: number, context?: RequestContext) =>
      client.request(
        'post',
        `/prediction/datasets/${encodeURIComponent(id)}/grants`,
        { revision },
        { ...context, csrf: 'required', validate: (value) => predictionGrantSchema.parse(value) },
      ),
    releaseGrant: (id: string, grantId: string) =>
      client.request(
        'post',
        `/prediction/datasets/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}/release`,
        {},
        { csrf: 'required' },
      ),
    models: (experimentId: number, context?: RequestContext) =>
      client.request('get', `/prediction/models?experiment_id=${experimentId}`, undefined, {
        ...context,
        validate: (value) => z.object({ items: z.array(predictionModelSchema) }).parse(value).items,
      }),
    reserve: (body: PredictionModelReservation, context?: RequestContext) =>
      client.request('post', '/prediction/models/reserve', body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionModelSchema.parse(value),
      }),
    complete: (id: string, revision: number, body: object, context?: RequestContext) =>
      client.request('post', `/prediction/models/${encodeURIComponent(id)}/revisions/${revision}/complete`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionModelSchema.parse(value),
      }),
    lease: (id: string, revision: number, jobId: string, release = false) =>
      client.request(
        'post',
        `/prediction/models/${encodeURIComponent(id)}/leases${release ? '/release' : ''}`,
        { revision, job_id: jobId },
        { csrf: 'required' },
      ),
    registerStorage: (body: { storage_id: string; launcher_id: string; name: string }, context?: RequestContext) =>
      client.request('post', '/prediction/storages', body, { ...context, csrf: 'required' }),
    deleteAsset: (kind: 'datasets' | 'models', id: string, body: object, complete = false, context?: RequestContext) =>
      client.request(
        'post',
        `/prediction/${kind}/${encodeURIComponent(id)}/delete${complete ? '/complete' : ''}`,
        body,
        { ...context, csrf: 'required' },
      ),
  }
}
export const predictionApi = createPredictionApi(browserClient)
