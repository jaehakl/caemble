import { browserClient } from '@/api/http'
import { submitArtifact } from '@/api/submitArtifact'
import type { CaeBatch } from '@/contracts/api/cae'
import { parseBuildArtifact } from '@/lib/cae/artifact'
import { BrowserArtifactStore } from '@/platform/browser/artifactStore'

export async function resumeBrowserUpload(
  batch: CaeBatch,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
) {
  if (typeof batch.request_id !== 'string' || !batch.request_id) {
    throw new Error('이 작업의 업로드 식별자가 없습니다. 작업 목록을 새로고침하세요.')
  }
  signal.throwIfAborted()
  const store = await BrowserArtifactStore.open(batch.request_id)
  try {
    const saved = await store.readManifest()
    if (!saved) throw new Error('이 브라우저에 저장된 빌드 결과가 없습니다. 처음 업로드한 브라우저에서 재개하세요.')
    const artifact = parseBuildArtifact(saved)
    if (artifact.items.length !== batch.total || artifact.mode !== batch.mode) {
      throw new Error('저장된 빌드 결과가 선택한 작업과 다릅니다. 처음 업로드한 브라우저에서 확인하세요.')
    }
    return await submitArtifact({
      client: browserClient,
      artifact,
      experimentId: batch.experiment_id,
      requestId: batch.request_id,
      readItem: (item) => store.readItem(item),
      signal,
      onProgress,
      onRegistered: (id) => {
        if (id !== batch.id) throw new Error('재개할 작업의 식별자가 원래 작업과 다릅니다.')
      },
    })
  } finally {
    store.close()
  }
}
