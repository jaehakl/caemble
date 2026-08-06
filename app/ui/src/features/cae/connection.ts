import { useSyncExternalStore } from 'react'
import { GpStationClient } from '@gpstation/v1-master-js-sdk'

let accessToken: string | null = null
const listeners = new Set<() => void>()

export function setCaeAccessToken(value: string | null): void {
  const normalized = value?.trim() || null
  if (normalized === accessToken) return
  accessToken = normalized
  listeners.forEach((listener) => listener())
}

export function clearCaeAccessToken(): void {
  setCaeAccessToken(null)
}

export async function connectCaeAccessToken(value: string): Promise<void> {
  const token = value.trim()
  if (!token) throw new Error('GPStation Access Token을 입력하세요.')
  const launchers = await new GpStationClient({
    apiBaseUrl: gpStationApiBaseUrl(),
    token,
  }).listLaunchers()
  const launcher = launchers.find(
    (candidate) => candidate.status !== 'disconnected' && candidate.slave_app_ids.includes('cae'),
  )
  if (!launcher) {
    throw new Error('현재 계정에 연결된 cae launcher가 없습니다.')
  }
  setCaeAccessToken(token)
}

export function useCaeAccessToken(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => accessToken,
    () => null,
  )
}

export function gpStationApiBaseUrl(): string {
  const configured = import.meta.env.VITE_GPSTATION_API_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return 'http://localhost:8000'
}
