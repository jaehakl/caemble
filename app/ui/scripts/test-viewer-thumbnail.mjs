import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer, transformWithEsbuild } from 'vite'
import { chromium } from 'playwright'

const server = await createServer({
  server: { port: 5194, strictPort: false, host: '127.0.0.1' },
  plugins: [
    {
      name: 'thumbnail-capture-fixture',
      resolveId(id) {
        if (id === '/thumbnail-fixture.tsx') return '\0thumbnail-fixture.tsx'
      },
      async load(id) {
        if (id !== '\0thumbnail-fixture.tsx') return
        return (
          await transformWithEsbuild(
            `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { primitives } from '@jscad/modeling';
    import JscadViewer from '/src/features/viewer/viewer/JscadViewer.tsx';
    import { ThumbnailCropEditor } from '/src/features/viewer/persistence/ThumbnailCropEditor.tsx';
    import { captureViewer, centeredThumbnailCrop, cropThumbnail } from '/src/features/viewer/persistence/viewerThumbnail.ts';
    import '/src/index.css';
    const part = {id:'box', geometry:primitives.cuboid({size:[3,2,1]}), surfaces:[], material:{color:'#2574b8'}};
    const layer = {source:'experiment', lengthUnit:'m', parts:[part], tree:{id:'root', children:[]}};
    const heatmap = {identity:'result', geometries:[{positions:new Float32Array([0,0,0,3,0,0,0,2,0]), colors:new Float32Array([1,0,0,1,0,1,0,1,0,0,1,1]),indices:new Uint16Array([0,1,2]), primitive:'triangles'}], bounds:{min:[0,0,0],max:[3,2,1]}};
    window.capture = async () => {
      const image = await captureViewer(document.getElementById('capture'));
      const thumbnail = await cropThumbnail(image, centeredThumbnailCrop(image.width,image.height));
      window.lastCapture=image; window.showCrop(image);
      const bitmap=await createImageBitmap(await (await fetch(thumbnail)).blob());
      const canvas=document.createElement('canvas'); canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const colors=new Set();for(let i=0;i<pixels.length;i+=4) colors.add(pixels[i]+','+pixels[i+1]+','+pixels[i+2]);
      return {width:bitmap.width,height:bitmap.height,bytes:atob(thumbnail.split(',')[1]).length,colors:colors.size};
    };
    function App(){ const [mode,setMode]=useState('geometry');const [capture,setCapture]=useState(null);const [crop,setCrop]=useState(null);
      window.showCrop=image=>{setCapture(image);setCrop(centeredThumbnailCrop(image.width,image.height))};
      window.cropValue=crop;
      return <div style={{padding:16}}>
        {['geometry','measurement','preflight','2d'].map(value=><button key={value} onClick={()=>setMode(value)}>{value}</button>)}
        <div id="capture" style={{position:'relative',width:800,height:450}}>
          {mode==='2d'?<svg width="800" height="450"><rect width="800" height="450" fill="white"/><path d="M30 400 L200 350 L400 80 L700 200" stroke="blue" strokeWidth="12" fill="none"/><text x="50" y="35">2D result · mm</text></svg>:<JscadViewer layers={[layer]} lengthUnit="m" heatmapRenderData={mode==='geometry'?undefined:heatmap} onRenderStart={()=>{}} onRenderEnd={()=>window.rendered=true} onRenderError={message=>{window.viewerError=message}}/>}
          <div style={{position:'absolute',bottom:10,right:10,background:'white'}}>범례 · 0–100 mm</div>
          <div data-capture-exclude style={{position:'absolute',top:0,left:0,width:30,height:30,background:'#ff00ff'}}>UI</div>
        </div>
        {capture&&crop?<div style={{width:480}}><ThumbnailCropEditor capture={capture} crop={crop} onChange={setCrop} disabled={false}/></div>:null}
      </div>
    }
    createRoot(document.getElementById('fixture')).render(<App/>);
  `,
            'thumbnail-fixture.tsx',
            { loader: 'tsx', jsx: 'automatic' },
          )
        ).code
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/thumbnail-fixture') return next()
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            await server.transformIndexHtml(
              '/thumbnail-fixture',
              '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module" src="/thumbnail-fixture.tsx"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/thumbnail-fixture`)
  await page.waitForFunction(() => window.rendered || window.viewerError)
  assert.equal(await page.evaluate(() => window.viewerError), undefined)
  await mkdir('node_modules/.tmp/thumbnail-browser', { recursive: true })
  for (const mode of ['geometry', 'measurement', 'preflight', '2d']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    await page.locator(mode === '2d' ? '#capture svg' : '#capture canvas').waitFor()
    const capture = await page.evaluate(() => window.capture())
    assert.equal(capture.width / capture.height, 4 / 3)
    assert.ok(capture.width <= 640 && capture.height <= 480 && capture.bytes <= 512 * 1024)
    assert.ok(capture.colors > 30, `${mode} must contain rendered content`)
    await page.getByAltText('저장 시점 Viewer').waitFor()
    await page.screenshot({ path: `node_modules/.tmp/thumbnail-browser/${mode}.png` })
    console.log(mode, capture)
  }
  assert.equal(await page.getByRole('slider').count(), 0)
  assert.equal(await page.getByAltText('크롭 미리보기').count(), 0)
  assert.equal(await page.getByText('썸네일 · 4:3 크롭').count(), 0)
  assert.equal(await page.getByRole('button', { name: '크롭 초기화' }).count(), 0)
  const area = page.getByRole('group', { name: '크롭 영역 이동' })
  const handle = page.getByRole('button', { name: '크롭 영역 크기 조절' })
  await handle.focus()
  await handle.press('ArrowLeft')
  assert.equal((await page.evaluate(() => window.cropValue)).width, 599)
  assert.equal((await page.evaluate(() => window.cropValue)).x, 100, 'resize must not also move the rectangle')
  await area.focus()
  await area.press('ArrowRight')
  assert.equal((await page.evaluate(() => window.cropValue)).x, 101)
  await handle.focus()
  await handle.press('Shift+ArrowLeft')
  const beforeDrag = await page.evaluate(() => window.cropValue)
  const bounds = await area.boundingBox()
  await page.mouse.move(bounds.x + 30, bounds.y + 30)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 42, bounds.y + 31, { steps: 3 })
  await page.mouse.up()
  const moved = await page.evaluate(() => window.cropValue)
  assert.ok(moved.x > beforeDrag.x && moved.y > beforeDrag.y)
  const grip = await handle.boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x - 45, grip.y - 35, { steps: 3 })
  await page.mouse.up()
  const resized = await page.evaluate(() => window.cropValue)
  assert.ok(resized.width < moved.width)
  assert.equal(resized.width / resized.height, 4 / 3)
  await area.focus()
  for (let i = 0; i < 100; i++) await area.press('Shift+ArrowRight')
  await area.press('ArrowDown')
  const clamped = await page.evaluate(() => window.cropValue)
  assert.equal(clamped.x + clamped.width, 800)
  assert.ok(clamped.y >= 0 && clamped.y + clamped.height <= 450)
  const saved = await page.evaluate(async () => {
    const { cropThumbnail } = await import('/src/features/viewer/persistence/viewerThumbnail.ts')
    const url = await cropThumbnail(window.lastCapture, window.cropValue)
    const blob = await (await fetch(url)).blob()
    const bitmap = await createImageBitmap(blob)
    return { width: bitmap.width, height: bitmap.height, type: blob.type, bytes: blob.size }
  })
  assert.equal(saved.width / saved.height, 4 / 3)
  assert.equal(saved.type, 'image/webp')
  assert.ok(saved.width <= 640 && saved.height <= 480 && saved.bytes <= 512 * 1024)
  await page.screenshot({ path: 'node_modules/.tmp/thumbnail-browser/crop-selection.png' })
  const result = await page.evaluate(async () => {
    const image = new Image()
    image.src = window.lastCapture.url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    return Array.from(ctx.getImageData(10, 10, 1, 1).data)
  })
  assert.notDeepEqual(result, [255, 0, 255, 255], 'excluded UI must not appear')
  assert.deepEqual(errors, [])
  console.log('Viewer capture, 4:3 crop, keyboard controls and UI exclusion passed.')
} finally {
  await browser?.close()
  await server.close()
}
