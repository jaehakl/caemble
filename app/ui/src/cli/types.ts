import type { CliEnvironment } from '@/platform/node/environment'
import type { CaembleClient } from '@/api/http'
export type CliOptions = Readonly<Record<string, string | boolean | undefined>>
export type CommandContext = Readonly<{
  environment: CliEnvironment
  options: CliOptions
  args: readonly string[]
  signal: AbortSignal
  client: () => CaembleClient
}>
