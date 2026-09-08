import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeBatch } from '@/contracts/api/cae'
import type { BuildArtifact } from '@/contracts/build'
import { resumeBrowserUpload } from './resumeUpload'

const mocks = vi.hoisted(() => ({ open: vi.fn(), manifest: vi.fn(), item: vi.fn(), close: vi.fn(), submit: vi.fn() }))
vi.mock('@/platform/browser/artifactStore', () => ({ BrowserArtifactStore: { open: mocks.open } }))
vi.mock('@/api/submitArtifact', () => ({ submitArtifact: mocks.submit }))

const artifact: BuildArtifact = {
  kind: 'caemble.build',
  version: 2,
  mode: 'generate',
  source_hash: 'a'.repeat(64),
  catalog_revision: 'original-catalog',
  builder_version: '2',
  source_bundle: { files: {} },
  items: [{ index: 1, file: 'items/1.json', input_hash: 'b'.repeat(64), byte_length: 3 }],
}
const batch: CaeBatch = {
  id: 'original-batch',
  request_id: 'original-request',
  experiment_id: 7,
  total: 1,
  mode: 'generate',
  state: 'uploading',
  uploaded_count: 0,
  created_count: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  created_at: '',
  updated_at: '',
  finished_at: null,
  last_event_id: 0,
  read_event_id: 0,
  jobs: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockResolvedValue({ readManifest: mocks.manifest, readItem: mocks.item, close: mocks.close })
  mocks.manifest.mockResolvedValue(artifact)
  mocks.item.mockResolvedValue(new Uint8Array([1, 2, 3]))
  mocks.submit.mockImplementation(async (options) => {
    await options.onRegistered(batch.id)
    return { ...batch, state: 'queued' }
  })
})

describe('resume frozen browser upload', () => {
  it('reuses the original request and stored bytes with no source rebuild', async () => {
    const signal = new AbortController().signal
    const progress = vi.fn()
    await expect(resumeBrowserUpload(batch, signal, progress)).resolves.toMatchObject({ state: 'queued' })
    expect(mocks.open).toHaveBeenCalledWith('original-request')
    const options = mocks.submit.mock.calls[0][0]
    expect(options).toMatchObject({
      artifact,
      experimentId: 7,
      requestId: 'original-request',
      signal,
      onProgress: progress,
    })
    expect(await options.readItem(artifact.items[0])).toEqual(new Uint8Array([1, 2, 3]))
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('does not register another batch when the saved build is unavailable', async () => {
    mocks.manifest.mockResolvedValue(undefined)
    await expect(resumeBrowserUpload(batch, new AbortController().signal, vi.fn())).rejects.toThrow(
      '이 브라우저에 저장된 빌드 결과가 없습니다.',
    )
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('closes the store when server registration does not match the original batch', async () => {
    mocks.submit.mockImplementation(async (options) => {
      await options.onRegistered('different-batch')
    })
    await expect(resumeBrowserUpload(batch, new AbortController().signal, vi.fn())).rejects.toThrow(
      '원래 작업과 다릅니다.',
    )
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
