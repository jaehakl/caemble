import 'monaco-editor/languages/features/typescript/ts.worker.js'
import { CadCompilationError } from './compilationError'
import type { CadCompilationRequest, CadCompilationResponse } from './compilerProtocol'
import { compileVirtualCadDocument } from './virtualCompiler'

// The client sends only one request at a time. Also serialize here so cleanup is
// complete before accepting another document even if a caller violates that rule.
let pending = Promise.resolve()
// Both consumers download the same engine bundle, but own separate Worker instances.
// Monaco's first bootstrap message installs its editor protocol; CAD requests keep
// the isolated, per-document protocol below and never synchronize editor models.
const startEditorWorker = self.onmessage
self.onmessage = (event: MessageEvent<CadCompilationRequest>) => {
  if (event.data?.type !== 'compile-cad') {
    startEditorWorker?.call(self, event)
    return
  }
  pending = pending.then(async () => {
    const request = event.data
    let response: CadCompilationResponse
    try {
      response = { requestId: request.requestId, type: 'success', document: await compileVirtualCadDocument(request) }
    } catch (cause) {
      response = {
        requestId: request.requestId,
        type: 'failure',
        errorType: cause instanceof CadCompilationError ? cause.errorType : 'compile',
        message: cause instanceof Error ? cause.message : String(cause),
        diagnostics: cause instanceof CadCompilationError ? cause.diagnostics : [],
      }
    }
    self.postMessage(response)
  })
}
