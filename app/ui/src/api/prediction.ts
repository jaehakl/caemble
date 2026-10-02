import { z } from 'zod'
import { browserClient, type CaembleClient, type RequestContext } from './http'
import {
  predictionDatasetSchema,
  predictionGrantSchema,
  predictionModelSchema,
  predictionStorageSchema,
  predictionOperationSchema,
  predictionAlgorithmSchema,
  type PredictionDatasetSelection,
  type PredictionModelReservation,
  type PredictionOperationRequest,
} from '@/contracts/api/prediction'

export function createPredictionApi(client: CaembleClient) {
  return {
    algorithms: (context?: RequestContext) =>
      client.request('get', '/prediction/algorithms', undefined, {
        ...context,
        validate: (value) => z.object({ items: z.array(predictionAlgorithmSchema) }).parse(value).items,
      }),
    datasets: (experimentId?: number, context?: RequestContext) =>
      client.request(
        'get',
        `/prediction/datasets${experimentId === undefined ? '' : `?experiment_id=${experimentId}`}`,
        undefined,
        {
          ...context,
          validate: (value) => z.object({ items: z.array(predictionDatasetSchema) }).parse(value).items,
        },
      ),
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
    models: (experimentId?: number, context?: RequestContext) =>
      client.request(
        'get',
        `/prediction/models${experimentId === undefined ? '' : `?experiment_id=${experimentId}`}`,
        undefined,
        {
          ...context,
          validate: (value) => z.object({ items: z.array(predictionModelSchema) }).parse(value).items,
        },
      ),
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
    lease: (
      id: string,
      revision: number,
      jobId: string,
      release = false,
      route?: { replica_id?: string; storage_id?: string },
      context?: RequestContext,
    ) =>
      client.request(
        'post',
        `/prediction/models/${encodeURIComponent(id)}/leases${release ? '/release' : ''}`,
        { revision, job_id: jobId, ...route },
        { ...context, csrf: 'required' },
      ),
    registerStorage: (body: { storage_id: string; launcher_id: string; name: string }, context?: RequestContext) =>
      client.request('post', '/prediction/storages', body, { ...context, csrf: 'required' }),
    storages: (context?: RequestContext) =>
      client.request('get', '/prediction/storages', undefined, {
        ...context,
        validate: (value) => z.object({ items: z.array(predictionStorageSchema) }).parse(value).items,
      }),
    operations: (experimentId?: number, context?: RequestContext) =>
      client.request(
        'get',
        `/prediction/operations${experimentId === undefined ? '' : `?experiment_id=${experimentId}`}`,
        undefined,
        {
          ...context,
          validate: (value) => z.object({ items: z.array(predictionOperationSchema) }).parse(value).items,
        },
      ),
    operation: (id: string, context?: RequestContext) =>
      client.request('get', `/prediction/operations/${encodeURIComponent(id)}`, undefined, {
        ...context,
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    createOperation: (body: PredictionOperationRequest, context?: RequestContext) =>
      client.request('post', '/prediction/operations', body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    retryOperation: (id: string, body: object = {}, context?: RequestContext) =>
      client.request('post', `/prediction/operations/${encodeURIComponent(id)}/grants`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    submitTraining: (id: string, body: { pin_id?: string } = {}, context?: RequestContext) =>
      client.request('post', `/prediction/operations/${encodeURIComponent(id)}/submit`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    retryTraining: (id: string, body: { request_id: string; pin_id?: string }, context?: RequestContext) =>
      client.request('post', `/prediction/operations/${encodeURIComponent(id)}/retry`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    preflightTraining: (id: string, body: { request_id: string }, context?: RequestContext) =>
      client.request('post', `/prediction/operations/${encodeURIComponent(id)}/training/preflight`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    cancelOperation: (id: string) =>
      client.request(
        'post',
        `/prediction/operations/${encodeURIComponent(id)}/cancel`,
        {},
        {
          csrf: 'required',
          validate: (value) => predictionOperationSchema.parse(value),
        },
      ),
    interruptOperation: (id: string, error: string) =>
      client.request(
        'post',
        `/prediction/operations/${encodeURIComponent(id)}/interrupt`,
        { error },
        {
          csrf: 'required',
          validate: (value) => predictionOperationSchema.parse(value),
        },
      ),
    checkReplica: (body: object, context?: RequestContext) =>
      client.request('post', '/prediction/replicas/check', body, { ...context, csrf: 'required' }),
    completeOperation: (id: string, body: object, context?: RequestContext) =>
      client.request('post', `/prediction/operations/${encodeURIComponent(id)}/complete`, body, {
        ...context,
        csrf: 'required',
        validate: (value) => predictionOperationSchema.parse(value),
      }),
    previewDataset: (id: string, body: PredictionDatasetSelection, context?: RequestContext) =>
      client.request('post', `/prediction/datasets/${encodeURIComponent(id)}/preview`, body, {
        ...context,
        csrf: 'required',
        validate: (value) =>
          z
            .object({
              added: z.number().int().nonnegative(),
              changed: z.number().int().nonnegative(),
              removed: z.number().int().nonnegative(),
            })
            .parse(value),
      }),
    renameAsset: (kind: 'datasets' | 'models', id: string, name: string) =>
      client.request('patch', `/prediction/${kind}/${encodeURIComponent(id)}`, { name }, { csrf: 'required' }),
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
