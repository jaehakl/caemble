import { GpStationClient } from '@gpstation/v1-master-js-sdk'
import type { GPStationConnectionData } from '@/api'
import { assertValidKernelDescriptor, type KernelDescriptor } from '@/lib/cad/simulation'

const ATTACHMENT_ID = 'solver-manifests'

export type CaeSolverManifest = Readonly<{
  schemaVersion: 1
  implementation: string
  descriptor: KernelDescriptor
}>

export class CaeManifestError extends Error {
  constructor(
    readonly code: 'protocol_error' | 'invalid_manifest',
    message: string,
  ) {
    super(message)
    this.name = 'CaeManifestError'
  }
}

export async function fetchCaeSolverManifests(
  connection: GPStationConnectionData,
): Promise<readonly CaeSolverManifest[]> {
  const client = new GpStationClient({
    apiBaseUrl: connection.api_base_url,
    token: connection.access_token,
  })
  const response = await client.runJob<Record<string, never>, unknown>(
    'cae.solvers.manifests',
    {},
    { slaveAppId: 'cae', timeoutMs: 60_000 },
  )
  if (
    !isRecord(response.payload) ||
    !hasExactKeys(response.payload, ['formatVersion', 'count', 'attachmentId']) ||
    response.payload.formatVersion !== 1 ||
    !Number.isSafeInteger(response.payload.count) ||
    (response.payload.count as number) < 0 ||
    response.payload.attachmentId !== ATTACHMENT_ID
  ) {
    throw new CaeManifestError('protocol_error', 'CAE solver manifest 응답 payload가 올바르지 않습니다.')
  }
  const file = response.files[0]
  if (
    response.files.length !== 1 ||
    file.id !== ATTACHMENT_ID ||
    file.name !== 'solver-manifests.json' ||
    file.mimeType !== 'application/json; charset=utf-8' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0
  ) {
    throw new CaeManifestError('protocol_error', 'CAE solver manifest attachment가 올바르지 않습니다.')
  }

  let decoded: unknown
  try {
    const bytes = await file.blob.arrayBuffer()
    if (bytes.byteLength !== file.size) {
      throw new Error('attachment size mismatch')
    }
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new CaeManifestError('invalid_manifest', 'CAE solver manifest attachment가 올바른 UTF-8 JSON이 아닙니다.')
  }
  if (!Array.isArray(decoded) || decoded.length !== response.payload.count) {
    throw new CaeManifestError('invalid_manifest', 'CAE solver manifest count가 attachment 내용과 다릅니다.')
  }

  const manifests = decoded.map((value, index) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'implementation', 'descriptor']) ||
      value.schemaVersion !== 1 ||
      typeof value.implementation !== 'string' ||
      !value.implementation ||
      !isRecord(value.descriptor)
    ) {
      throw new CaeManifestError('invalid_manifest', `solver manifests[${index}] 구조가 올바르지 않습니다.`)
    }
    try {
      assertValidKernelDescriptor(value.descriptor as KernelDescriptor)
    } catch (error) {
      throw new CaeManifestError(
        'invalid_manifest',
        `solver manifests[${index}].descriptor: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      implementation: value.implementation,
      descriptor: Object.freeze(value.descriptor) as KernelDescriptor,
    })
  })
  const identities = manifests.map(({ descriptor }) => `${descriptor.name}@${descriptor.version}`)
  if (
    new Set(identities).size !== identities.length ||
    identities.some((identity, index) => index > 0 && identity < identities[index - 1])
  ) {
    throw new CaeManifestError(
      'invalid_manifest',
      'CAE solver manifests는 중복 없이 identity 순서로 정렬되어야 합니다.',
    )
  }
  return Object.freeze(manifests)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
