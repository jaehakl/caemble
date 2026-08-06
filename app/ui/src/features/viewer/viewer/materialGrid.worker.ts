import { createMaterialGrid, type MaterialGridWorkerRequest, type MaterialGridWorkerResponse } from './materialGrid'

self.onmessage = (event: MessageEvent<MaterialGridWorkerRequest>) => {
  const { parts, requestId, requestedSpacing } = event.data

  try {
    const result = createMaterialGrid(parts, requestedSpacing)
    const response: MaterialGridWorkerResponse = {
      requestId,
      result,
      type: 'success',
    }
    ;(self.postMessage as unknown as (message: MaterialGridWorkerResponse, transfer: Transferable[]) => void)(
      response,
      [result.positions.buffer as ArrayBuffer, result.colors.buffer as ArrayBuffer],
    )
  } catch (error) {
    const typedError = error as { message?: string }
    const response: MaterialGridWorkerResponse = {
      message: typedError.message ?? String(error),
      requestId,
      type: 'error',
    }
    self.postMessage(response)
  }
}
