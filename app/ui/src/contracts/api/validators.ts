import { z } from 'zod'

import type { GetListResponse, UpsertResponse } from './common'

const getListResponseSchema = z
  .object({
    items: z.array(z.unknown()),
    total: z.number().int().nonnegative(),
  })
  .passthrough()

export const databaseIdSchema = z.number().int().positive()
const idResponseSchema = z.object({ id: databaseIdSchema }).passthrough()

export function parseGetListResponse<TItem>(value: unknown, itemSchema?: z.ZodType): GetListResponse<TItem> {
  const response = getListResponseSchema.parse(value)
  if (!itemSchema) return response as GetListResponse<TItem>
  return {
    ...response,
    items: response.items.map((item) => itemSchema.parse(item)),
  } as GetListResponse<TItem>
}

export function parseIdResponse(value: unknown): Readonly<{ id: number }> {
  return idResponseSchema.parse(value)
}

export function parseUpsertResponseList(value: unknown): UpsertResponse[] {
  return z.array(idResponseSchema).parse(value)
}

export function parseBooleanResponse(value: unknown): boolean {
  return z.boolean().parse(value)
}

export function parseEmptyResponse(value: unknown): void {
  z.union([z.null(), z.undefined()]).parse(value)
}
