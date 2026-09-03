export type AccessKeyScope = 'client' | 'launcher'

export type AccessKeyRecord = Readonly<{
  id: string
  user_id: string
  key_type: string
  name: string | null
  key_prefix: string
  scopes: readonly string[]
  status: string
  rate_limit_per_minute?: number | null
  allowed_ips?: readonly string[] | null
  allowed_origins?: readonly string[] | null
  last_used_at?: string | null
  expires_at?: string | null
  created_at?: string | null
  revoked_at?: string | null
}>

export type UserRecord = Readonly<{
  id: string
  email?: string | null
  display_name?: string | null
  picture_url?: string | null
  is_active?: boolean | null
  roles: readonly string[]
  created_at?: string | null
  updated_at?: string | null
  experiment_namespaces: readonly string[]
}>

export type LauncherRecord = Readonly<{
  id: string
  user_id: string
  launcher_name: string
  ip_address?: string | null
  status: string
  slave_app_ids: readonly string[]
  connected_at?: string | null
  last_heartbeat_at?: string | null
  disconnected_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}>

export type LauncherRuntime = Readonly<{
  launcher_id: string
  current_job_id?: string | null
  loaded_slave_app_id?: string | null
  worker_status?: string | null
  resetting: boolean
  metadata: Readonly<Record<string, unknown>>
}>

export type JobState = string

export type JobSummary = Readonly<{
  id: string
  user_id: string
  handler_type: string
  slave_app_id: string
  state: JobState
  latest_progress: Readonly<{ time: string; progress: unknown }> | null
  launcher_id?: string | null
  assigned_at?: string | null
  answer_ready_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  cancel_requested_at?: string | null
  last_error?: string | null
  attempt_count: number
  created_at?: string | null
  updated_at?: string | null
}>

export type RuntimeCrudListRequest = Readonly<{
  offset: number
  limit: number | null
  selected_ids: readonly string[]
  search_text: string | null
  text_filter: Readonly<Record<string, readonly string[]>>
  filter: Readonly<Record<string, readonly unknown[]>>
  sort: readonly [string, 'asc' | 'desc'] | null
}>
