import { toCanvas } from 'html-to-image'

export type ViewerCapture = { url: string; width: number; height: number }
export type ThumbnailCrop = { x: number; y: number; width: number; height: number }

export function centeredThumbnailCrop(width: number, height: number): ThumbnailCrop {
  const cropWidth = Math.min(width, (height * 4) / 3)
  const cropHeight = (cropWidth * 3) / 4
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight }
}

export async function captureViewer(node: HTMLElement | null): Promise<ViewerCapture> {
  if (!node || node.clientWidth < 1 || node.clientHeight < 1 || node.querySelector('[data-viewer-empty="true"]')) {
    throw new Error('캡처할 Viewer 화면이 없습니다. 기본 또는 기존 이미지를 사용합니다.')
  }
  node.querySelectorAll('canvas').forEach((canvas) => canvas.dispatchEvent(new Event('caemble-before-capture')))
  const canvas = await toCanvas(node, {
    pixelRatio: 1,
    backgroundColor: '#ffffff',
    skipFonts: true,
    width: node.clientWidth,
    height: node.clientHeight,
    filter: (element) => !(element instanceof Element && element.matches('[data-capture-exclude],button,input,select')),
  })
  return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

export async function cropThumbnail(capture: ViewerCapture, crop: ThumbnailCrop): Promise<string> {
  const image = new Image()
  image.src = capture.url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(4, Math.min(160, Math.floor(crop.width / 4)) * 4)
  canvas.height = (canvas.width * 3) / 4
  const context = canvas.getContext('2d')
  if (!context) throw new Error('썸네일 이미지를 만들 수 없습니다.')
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
  for (const quality of [0.9, 0.75, 0.5]) {
    const url = canvas.toDataURL('image/webp', quality)
    if (!url.startsWith('data:image/webp;base64,')) throw new Error('이 브라우저는 WebP 저장을 지원하지 않습니다.')
    if (atob(url.split(',')[1]).length <= 512 * 1024) return url
  }
  throw new Error('썸네일이 512KiB를 초과합니다. 크롭 영역을 줄이세요.')
}
