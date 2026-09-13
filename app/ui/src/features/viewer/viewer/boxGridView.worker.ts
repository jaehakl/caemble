import { calculateBoxGridView, type BoxGridViewRequest } from './boxGridViewData'

self.onmessage = ({ data }: MessageEvent<BoxGridViewRequest>) => {
  try {
    self.postMessage({ result: calculateBoxGridView(data) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
