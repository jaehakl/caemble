import { compileCadDocument } from '@/lib/cad/compiler/monacoCompiler'
import { prepareInIsolatedRunner } from '@/platform/isolated-runner/client'
import type { CaePreparationRequest } from '@/lib/cae/build'
import type { BuiltArtifactInput } from '@/lib/cae/artifact'

export async function prepareBrowserMeasurement(
  request: CaePreparationRequest,
  signal?: AbortSignal,
): Promise<BuiltArtifactInput> {
  signal?.throwIfAborted()
  const compiledDocument = await compileCadDocument(
    { kind: 'experiment', sourceBundle: request.source_bundle },
    { catalog: request.catalog, catalogRevision: request.catalog.catalogRevision },
  )
  if (compiledDocument.sourceHash !== request.source_hash) throw new Error('The source changed before building.')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cancel()
      finish()
      reject(new DOMException('Build cancelled.', 'AbortError'))
    }
    const cancel = prepareInIsolatedRunner(
      { ...request, type: 'prepare', requestId: crypto.randomUUID(), revision: 0, compiledDocument },
      {
        onStart: () => {
          timer = setTimeout(() => {
            cancel()
            finish()
            reject(new Error('Experiment build timed out.'))
          }, request.evaluation_timeout_ms ?? 3000)
        },
        onFailure: (message) => {
          finish()
          reject(new Error(message))
        },
        onResponse: (response) => {
          finish()
          if (response.type === 'preparation-success') resolve(response.input)
          else reject(new Error(response.message))
        },
      },
    )
    signal?.addEventListener('abort', abort, { once: true })
  })
}
