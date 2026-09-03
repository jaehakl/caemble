import { z } from 'zod'
import type { GetListResponse } from './common'
import type { AccessKeyRecord, JobSummary, LauncherRecord, LauncherRuntime, UserRecord } from './runtime'
import { parseGetListResponse } from './validators'

const nullableTimestampSchema = z.string().nullable().optional()

const accessKeyRecordSchema = z
  .object({
    id: z.string().min(1),
    user_id: z.string().min(1),
    key_type: z.string().min(1),
    name: z.string().nullable(),
    key_prefix: z.string().min(1),
    scopes: z.array(z.string()),
    status: z.string().min(1),
    rate_limit_per_minute: z.number().int().nonnegative().nullable().optional(),
    allowed_ips: z.array(z.string()).nullable().optional(),
    allowed_origins: z.array(z.string()).nullable().optional(),
    last_used_at: nullableTimestampSchema,
    expires_at: nullableTimestampSchema,
    created_at: nullableTimestampSchema,
    revoked_at: nullableTimestampSchema,
  })
  .passthrough()

const launcherRecordSchema = z
  .object({
    id: z.string().min(1),
    user_id: z.string().min(1),
    launcher_name: z.string().min(1),
    ip_address: z.string().nullable().optional(),
    status: z.string().min(1),
    slave_app_ids: z.array(z.string()),
    connected_at: nullableTimestampSchema,
    last_heartbeat_at: nullableTimestampSchema,
    disconnected_at: nullableTimestampSchema,
    created_at: nullableTimestampSchema,
    updated_at: nullableTimestampSchema,
  })
  .passthrough()

const launcherRuntimeSchema = z
  .object({
    launcher_id: z.string().min(1),
    current_job_id: z.string().nullable().optional(),
    loaded_slave_app_id: z.string().nullable().optional(),
    worker_status: z.string().nullable().optional(),
    resetting: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .passthrough()

const jobSummarySchema = z
  .object({
    id: z.string().min(1),
    user_id: z.string().min(1),
    handler_type: z.string().min(1),
    slave_app_id: z.string().min(1),
    state: z.string().min(1),
    latest_progress: z
      .object({
        time: z.string(),
        progress: z.unknown(),
      })
      .passthrough()
      .nullable(),
    launcher_id: z.string().nullable().optional(),
    assigned_at: nullableTimestampSchema,
    answer_ready_at: nullableTimestampSchema,
    started_at: nullableTimestampSchema,
    finished_at: nullableTimestampSchema,
    cancel_requested_at: nullableTimestampSchema,
    last_error: z.string().nullable().optional(),
    attempt_count: z.number().int().nonnegative(),
    created_at: nullableTimestampSchema,
    updated_at: nullableTimestampSchema,
  })
  .passthrough()

const accessKeyCreateResponseSchema = z
  .object({
    access_key: accessKeyRecordSchema,
    secret: z.string().min(1),
  })
  .passthrough()

const deletedResponseSchema = z.object({ deleted: z.number().int().nonnegative() }).passthrough()
const okResponseSchema = z.object({ ok: z.literal(true) }).passthrough()
const launcherReconcileResponseSchema = okResponseSchema.extend({ launchers: z.number().int().nonnegative() })

export const userRecordSchema = z
  .object({
    id: z.string().min(1),
    roles: z.array(z.string()),
    experiment_namespaces: z.array(z.string()),
  })
  .passthrough()

export function parseUserRecord(value: unknown): UserRecord {
  return userRecordSchema.parse(value) as UserRecord
}

export function parseUserRecordList(value: unknown): UserRecord[] {
  return z.array(userRecordSchema).parse(value) as UserRecord[]
}

export function parseNullableUserRecord(value: unknown): UserRecord | null {
  return userRecordSchema.nullable().parse(value) as UserRecord | null
}

export function parseAccessKeyListResponse(value: unknown): GetListResponse<AccessKeyRecord> {
  return parseGetListResponse<AccessKeyRecord>(value, accessKeyRecordSchema)
}

export function parseAccessKeyCreateResponse(
  value: unknown,
): Readonly<{ access_key: AccessKeyRecord; secret: string }> {
  return accessKeyCreateResponseSchema.parse(value) as Readonly<{ access_key: AccessKeyRecord; secret: string }>
}

export function parseDeletedResponse(value: unknown): Readonly<{ deleted: number }> {
  return deletedResponseSchema.parse(value)
}

export function parseLauncherListResponse(value: unknown): GetListResponse<LauncherRecord> {
  return parseGetListResponse<LauncherRecord>(value, launcherRecordSchema)
}

export function parseLauncherRuntimeList(value: unknown): LauncherRuntime[] {
  return z.array(launcherRuntimeSchema).parse(value) as LauncherRuntime[]
}

export function parseLauncherReconcileResponse(value: unknown): Readonly<{ ok: true; launchers: number }> {
  return launcherReconcileResponseSchema.parse(value)
}

export function parseOkResponse(value: unknown): Readonly<{ ok: true }> {
  return okResponseSchema.parse(value)
}

export function parseJobSummaryList(value: unknown): JobSummary[] {
  return z.array(jobSummarySchema).parse(value) as JobSummary[]
}
