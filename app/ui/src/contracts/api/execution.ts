import { z } from 'zod'

export const resourceRequestSchema = z
  .object({
    cpu_cores: z.number().int().positive().optional(),
    startup_ram_bytes: z.number().int().positive().optional(),
    gpu_count: z.number().int().nonnegative().optional(),
    vram_budget_gb: z
      .number()
      .finite()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 1024 ** 3)
      .optional(),
  })
  .strict()
  .refine((value) => value.gpu_count !== 0 || value.vram_budget_gb === undefined, {
    message: 'A CPU-only request cannot reserve GPU memory.',
  })

export const resourceAllocationSchema = z.object({
  cpu_ids: z.array(z.number().int().nonnegative()),
  cpu_cores: z.number().int().positive(),
  startup_ram_bytes: z.number().int().positive(),
  ram_available_bytes: z.number().int().nonnegative(),
  gpu_devices: z.array(z.string()),
  vram_budget_bytes: z.record(z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).optional(),
  // Historical protocol-2 allocations are readable, but never accepted as new requests.
  gpu_memory_bytes: z.number().int().nonnegative().optional(),
})

export const launcherInstanceSchema = z
  .object({
    launcher_id: z.string(),
    boot_id: z.string(),
    instance_id: z.string(),
    job_id: z.string(),
    attempt_id: z.string(),
    attempt_count: z.number().int().positive(),
    reservation_id: z.string(),
    slave_app_id: z.string(),
    state: z.string(),
    allocation: resourceAllocationSchema.nullable().optional(),
    ram_used_bytes: z.number().int().nonnegative().nullable().optional(),
    vram_used_bytes: z.record(z.string(), z.number().int().nonnegative()).nullable().optional(),
    vram_monitoring_status: z.enum(['healthy', 'unavailable']).optional(),
    vram_monitoring_warning: z.string().nullable().optional(),
  })
  .passthrough()

export const launcherResourcesSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    admission_open: z.boolean().optional(),
    waiting_reason: z.string().nullable().optional(),
    cpu_total: z.number().int().nonnegative().optional(),
    cpu_reserved: z.number().int().nonnegative().optional(),
    ram_budget_bytes: z.number().int().nonnegative().optional(),
    ram_used_bytes: z.number().int().nonnegative().nullable().optional(),
    ram_startup_reserved_bytes: z.number().int().nonnegative().optional(),
    gpu_devices: z
      .array(
        z
          .object({
            uuid: z.string(),
            total_bytes: z.number().int().positive(),
            vram_reserved_bytes: z.number().int().nonnegative().optional(),
            vram_monitoring_status: z.enum(['healthy', 'unavailable']).optional(),
            vram_monitoring_warning: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    vram_monitoring_status: z.enum(['healthy', 'unavailable']).optional(),
    vram_monitoring_warning: z.string().nullable().optional(),
  })
  .passthrough()

export type ResourceRequest = z.infer<typeof resourceRequestSchema>
export type ResourceAllocation = z.infer<typeof resourceAllocationSchema>
export type LauncherInstance = z.infer<typeof launcherInstanceSchema>
export type LauncherResources = z.infer<typeof launcherResourcesSchema>
