import { GpStationClient } from '@gpstation/v1-master-js-sdk'
import type { GPStationConnectionData } from '@/api'

export async function validateGpStationConnection(
  value: GPStationConnectionData,
): Promise<{ hasOnlineCaeLauncher: boolean }> {
  const apiBaseUrl = value.api_base_url.trim().replace(/\/+$/, '')
  const token = value.access_token.trim()
  if (!apiBaseUrl) throw new Error('GPStation API URL을 입력하세요.')
  if (!token) throw new Error('GPStation Access Token을 입력하세요.')
  const launchers = await new GpStationClient({
    apiBaseUrl,
    token,
  }).listLaunchers()
  return {
    hasOnlineCaeLauncher: launchers.some(
      (candidate) => candidate.status !== 'disconnected' && candidate.slave_app_ids.includes('cae'),
    ),
  }
}
