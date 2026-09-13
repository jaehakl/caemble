import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { transformSync } from 'esbuild'

const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'box-grid-viewer-fixture',
      resolveId(id) {
        if (id === '/box-grid-fixture.tsx') return '\0box-grid-fixture'
      },
      load(id) {
        if (id !== '\0box-grid-fixture') return
        return transformSync(
          `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import modeling from '@jscad/modeling';
      import { BoxGridResult } from '/src/features/viewer/viewer/BoxGridResult.tsx';
      import { WorkbenchViewer } from '/src/features/cae-workbench/viewer/WorkbenchViewer.tsx';
      import { materialVarsHash } from '/src/lib/material/resolution.ts';
      import JscadViewer from '/src/features/viewer/viewer/JscadViewer.tsx';
      import { CalculationOutputChart } from '/src/features/calculation/CalculationOutputChart.tsx';
      import { boxGrid } from '/src/lib/calculation/boxGridProject.ts';
      import { normalizeCalculationOutput } from '/src/lib/calculation/validation.ts';
      import { MeshFieldResult } from '/src/features/viewer/viewer/MeshFieldResult.tsx';
      import '/src/index.css';
      const shape = [4,3,2,2,2,2,3];
      const axes = ['x','y','z','time','frequency','amplitudePhase','component'].map((name,i)=>({name,ticks: i < 3 ? Array.from({length:shape[i]},(_,j)=>(j+.5)/shape[i]) : i===3 ? [0,1] : i===4 ? [0,10] : i===5 ? ['amplitude','phase'] : ['x','y','z'],unit:i<3?'m':i===3?'s':i===4?'Hz':undefined}));
      const grid = { version:1,sampling:'point',components:['x','y','z'],channels:['amplitude','phase'],channelUnits:['m','rad'],origin:[0,0,0],size:[1,1,1],rotation:[[1,0,0],[0,1,0],[0,0,1]],lengthUnit:'m',gridShape:shape.slice(0,3),source:'task',rootId:'probe' };
      const values = Array.from({length:shape.reduce((a,b)=>a*b,1)},(_,i)=>Math.floor(i/3)%2 ? 0.3 : 1+(i%3)+Math.floor(i/6)*.01);
      const bytes=new Uint8Array(new Float64Array(values).buffer);
      const tensor={shape,axes:axes.map(({ticks})=>({ticks})),boxGrid:grid,storage:{kind:'base64',data:btoa(String.fromCharCode(...bytes)),byteLength:bytes.length}};
      const rule={label:'signal',result:{dtype:'float64',tensorOrder:1,unit:'m',axes:axes.map(({name,unit})=>({name,unit})),boxGrid:grid},methodId:'stored',parameters:{},target:[]};
      const layers=[{source:'experiment',lengthUnit:'m',parts:[{id:'body',geometry:modeling.primitives.cuboid({size:[.5,.5,.5],center:[.5,.5,.5]}),materialRole:'body',surfaces:[]}],tree:{key:'root',label:'Geometry',children:[]}}];
      const noop=()=>{}; const root=createRoot(document.getElementById('fixture'));
      window.leaf={dtype:'float64',shape,data:values,axes,tensorOrder:1,boxGrid:grid,unit:'m'};
      window.executeCopy = (code) => new Function('samples','boxGrid','return '+code)({signal:window.leaf},boxGrid);
      window.renderBox = (compatible=true)=>root.render(<BoxGridResult name="signal" rules={[rule]} data={{signal:tensor}} displayUnit="m" recordReference="samples['signal']" canOverlayGeometry={compatible} renderViewer={(data,geometryOpacity)=><JscadViewer layers={layers} lengthUnit="m" heatmapRenderData={data} geometryOpacity={geometryOpacity} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>}/>);
      window.renderSizedCalculation=(values=[0,1,-4,4])=>root.render(<CalculationOutputChart preview={{status:'success',output:normalizeCalculationOutput({dtype:'float64',data:values.map(value=>[[value]]),axes:[{name:'x',ticks:[0,1,2,3]},{name:'y',ticks:[0]},{name:'z',ticks:[0]}]})}}/>);
      window.pointPixelWidths=async()=>{
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const canvas=document.querySelector('[data-result-visualization="point-cloud"] canvas');
        const gl=canvas.getContext('webgl'); const pixels=new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const columns=new Set();
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
          const i=(y*canvas.width+x)*4; const rgb=[pixels[i],pixels[i+1],pixels[i+2]];
          if(Math.max(...rgb)-Math.min(...rgb)>80)columns.add(x);
        }
        const widths=[];let previous=-2;
        for(const x of [...columns].sort((a,b)=>a-b)){if(x!==previous+1)widths.push(0);widths[widths.length-1]++;previous=x;}
        return widths.sort((a,b)=>a-b);
      };
      window.renderCalculation=()=>root.render(<CalculationOutputChart preview={{status:'success',output:normalizeCalculationOutput(boxGrid.project(window.leaf,{axes:['x','y','z'],component:'magnitude'}))}}/>);
      window.renderMesh=()=>root.render(<MeshFieldResult field={{label:'mesh',identity:'mesh',lengthUnit:'m',valueUnit:'m',quantity:'Displacement',valueKind:'displacement',location:'node',points:new Float64Array([0,0,0,1,0,0,0,1,0,0,0,1]),cells:new Uint32Array([0,1,2,3]),values:new Float64Array(12).fill(.01),componentCount:3,components:['x','y','z'],boundaryFaces:new Uint32Array([0,1,2,0,1,3,0,2,3,1,2,3]),boundaryCells:new Uint32Array([0,0,0,0]),cellRegions:new Uint32Array([0]),regionIds:['body'],supportNodes:new Uint32Array(),loadPoints:new Float64Array(),loadVectors:new Float64Array()}}/>);
      window.renderWorkbench = (mismatch='')=>root.render(<WorkbenchViewer
        experiment={{kind:'experiment',sourceBundle:{files:{'simulate.py':'fixture'}}}}
        experimentDocument={{scene:layers[0],evaluatedSnapshot:{sourceHash:'source',variables:{}},handleRenderStart:noop,handleRenderEnd:noop,handleRenderError:message=>{throw new Error(message)}}}
        resultSourceHash={mismatch==='source'?'changed':'source'} resultVarsHash={mismatch==='vars'?'changed':materialVarsHash({})}
        resultContracts={{signal:{task:'solid',output:'signal',solver:{name:'fixture',version:'1'},catalogRevision:'frozen',artifactType:'fixture@1',schema:rule.result,visualization:{kind:'box-grid'}}}}
        recordedRules={[rule]} recordedData={{signal:tensor}} autoSelectResult
        onFindSelectionSource={noop} onSelectionQueryChange={noop} onSelectionSourcePathsChange={noop} onToggleViewerExpanded={noop} selectionQuery={null} selectionSourceStatus={{}} viewerExpanded={false}
      />);
      window.renderBox();
      window.renderLargeBox=()=>{
        const shape=[24,24,12,4,4,2,3];
        const axes=window.leaf.axes.map((axis,i)=>({...axis,ticks:i<5?Array.from({length:shape[i]},(_,j)=>i<3?(j+.5)/shape[i]:j):axis.ticks}));
        const values=Float64Array.from({length:shape.reduce((a,b)=>a*b,1)},(_,i)=>Math.floor(i/3)%2?0:1+i%3);
        const bytes=new Uint8Array(values.buffer),chunks=[];
        for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
        const boxGrid={...grid,gridShape:shape.slice(0,3)};
        const tensor={shape,axes:axes.map(({ticks})=>({ticks})),boxGrid,storage:{kind:'base64',data:btoa(chunks.join('')),byteLength:bytes.length}};
        root.render(<BoxGridResult key="large" name="signal" rules={[{...rule,result:{...rule.result,axes:axes.map(({name,unit})=>({name,unit})),boxGrid}}]} data={{signal:tensor}} displayUnit="m" canOverlayGeometry={false} renderViewer={noop}/>);
      };
    `,
          { loader: 'tsx', jsx: 'automatic' },
        ).code
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== '/box-grid-fixture') return next()
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            await vite.transformIndexHtml(
              '/box-grid-fixture',
              '<html><head><meta charset="utf-8"></head><body><div id="fixture" style="height:100vh"></div><script type="module" src="/box-grid-fixture.tsx"></script></body></html>',
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/box-grid-fixture`)
  const ready = () =>
    page
      .waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent.includes('복사') && !button.disabled,
        ),
      )
      .catch(async (error) => {
        console.error(errors, await page.locator('body').innerText())
        throw error
      })
  await ready()
  assert.equal(await page.getByLabel('표시 축 1', { exact: true }).inputValue(), 'x')
  assert.equal(await page.getByLabel('표시 축 2', { exact: true }).inputValue(), 'y')
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), true)
  assert.equal(await page.getByLabel('Geometry 투명도').count(), 1)
  await page.getByRole('button', { name: 'Histogram', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('Geometry 투명도').count(), 0)
  await page.getByRole('button', { name: 'Heatmap', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), true)
  await page.getByLabel('Geometry 겹치기').uncheck()
  assert.equal(await page.getByLabel('Geometry 투명도').count(), 0)
  await mkdir('node_modules/.tmp/viewer-qa', { recursive: true })
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/heatmap.png' })
  await page.getByRole('button', { name: 'Line Chart', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('표시 축 1', { exact: true }).inputValue(), 'frequency')
  assert.equal(await page.getByLabel('표시 축 2', { exact: true }).inputValue(), 'time')
  await page.getByRole('button', { name: '변환 코드 복사', exact: true }).click()
  const line = await page.evaluate(async () => window.executeCopy(await navigator.clipboard.readText()))
  assert.deepEqual(
    line.axes.map((axis) => axis.ticks.length),
    [2, 2],
  )
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/line.png' })
  await page.getByRole('button', { name: 'Histogram', exact: true }).click()
  await ready()
  await page.getByLabel('Animation 모드').selectOption('time')
  await ready()
  await page.getByLabel('Animation 프레임').fill('1')
  await ready()
  await page.getByRole('button', { name: '변환 코드 복사', exact: true }).click()
  const histogram = await page.evaluate(async () => window.executeCopy(await navigator.clipboard.readText()))
  assert.deepEqual(
    histogram.axes.map((axis) => axis.ticks.length),
    [4, 3, 2, 1, 2],
  )
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/histogram.png' })
  await page.getByRole('button', { name: '3D Point cloud', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('성분', { exact: true }).inputValue(), 'arrows')
  await page.getByRole('button', { name: '변환 코드 4줄 복사', exact: true }).click()
  const four = await page.evaluate(async () =>
    (await navigator.clipboard.readText()).split('\n').map(window.executeCopy),
  )
  assert.equal(four.length, 4)
  assert.deepEqual(
    four[3].axes.map((axis) => axis.ticks.length),
    [4, 3, 2],
  )
  await page.getByLabel('Animation 모드').selectOption('oscillation')
  await ready()
  await page.getByLabel('Animation 프레임').fill('90')
  await ready()
  await page.getByRole('button', { name: '재생', exact: true }).click()
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Animation 프레임"]').value) !== 90)
  await page.getByRole('button', { name: '일시정지', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), false)
  await page.getByLabel('Geometry 겹치기').check()
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/arrows-overlay.png' })
  assert.ok(await page.getByLabel('길이 Scale bar').textContent())
  await page.getByLabel('Animation 모드').selectOption('off')
  await ready()
  await page.getByLabel('표시 축 3', { exact: true }).selectOption('time')
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isDisabled(), true)
  assert.equal(await page.getByLabel('길이 Scale bar').count(), 0)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/mixed-cloud.png' })
  await page.getByRole('button', { name: 'Heatmap', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), true)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/plane-overlay.png' })
  await page.evaluate(() => window.renderBox(false))
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isDisabled(), true)
  await page.getByLabel('채널', { exact: true }).selectOption('phase')
  await ready()
  assert.equal(await page.getByLabel('성분', { exact: true }).inputValue(), '0')
  await page.setViewportSize({ width: 720, height: 700 })
  await page.locator('summary').click()
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/narrow.png' })
  await page.evaluate(() => window.renderCalculation())
  await page.waitForSelector('[data-result-visualization="point-cloud"] canvas')
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/calculation-3d.png' })
  await page.evaluate(() => window.renderLargeBox())
  await page.getByRole('button', { name: 'Histogram', exact: true }).click()
  await page.getByRole('button', { name: 'Line Chart', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('표시 축 2', { exact: true }).inputValue(), 'time')
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/large-data.png' })
  await page.evaluate(() => window.renderMesh())
  const mesh = page.locator('[data-viewer-canvas]')
  await mesh.waitFor()
  assert.ok((await mesh.boundingBox()).height > 350)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/mesh.png' })
  await page.setViewportSize({ width: 1200, height: 850 })
  await page.evaluate(() => window.renderWorkbench())
  await ready()
  assert.equal(await page.getByLabel('Viewer 결과 선택').inputValue(), 'signal')
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), true)
  await page.waitForSelector('[aria-label="3D CAD Viewer"] canvas')
  assert.equal(await page.getByLabel('Geometry 겹치기').isEnabled(), true)
  await page.getByLabel('표시 축 2', { exact: true }).selectOption('frequency')
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isDisabled(), true)
  await page.getByRole('button', { name: '3D Point cloud', exact: true }).click()
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isEnabled(), true)
  assert.equal(await page.getByLabel('Geometry 겹치기').isChecked(), true)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/preflight-box-overlay.png' })
  await page.getByLabel('표시 축 3', { exact: true }).selectOption('time')
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isDisabled(), true)
  await page.getByLabel('표시 축 3', { exact: true }).selectOption('z')
  for (const mismatch of ['source', 'vars']) {
    await page.evaluate((value) => window.renderWorkbench(value), mismatch)
    await ready()
    assert.equal(await page.getByLabel('Geometry 겹치기').isDisabled(), true)
    assert.ok(
      await page
        .getByRole('status')
        .filter({ hasText: mismatch === 'source' ? 'source가 달라' : 'Vars가 달라' })
        .count(),
    )
  }
  await page.evaluate(() => window.renderWorkbench())
  await ready()
  assert.equal(await page.getByLabel('Geometry 겹치기').isEnabled(), true)
  for (const deviceScaleFactor of [1, 2]) {
    const sizedContext = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor })
    const sizedPage = await sizedContext.newPage()
    sizedPage.on('pageerror', (error) => errors.push(error.message))
    await sizedPage.goto(`http://127.0.0.1:${server.httpServer.address().port}/box-grid-fixture`)
    await sizedPage.evaluate(() => window.renderSizedCalculation())
    await sizedPage.getByRole('button', { name: 'Set z camera view', exact: true }).click()
    await sizedPage.waitForFunction(async () => (await window.pointPixelWidths()).length === 3)
    const widths = await sizedPage.evaluate(() => window.pointPixelWidths())
    // Rasterization can include one extra edge pixel at fractional screen positions.
    widths.forEach((width, i) => assert.ok(Math.abs(width - [5, 10, 10][i] * deviceScaleFactor) <= 1))
    assert.ok(await sizedPage.getByText('3 / 4 표본 표시 · 0값 1개 숨김').count())
    await sizedPage.screenshot({ path: `node_modules/.tmp/viewer-qa/point-area-${deviceScaleFactor}x.png` })
    await sizedPage.evaluate(() => window.renderSizedCalculation([0, 0, 0, 0]))
    await sizedPage.getByText('0 / 4 표본 표시 · 0값 4개 숨김').waitFor()
    assert.deepEqual(await sizedPage.evaluate(() => window.pointPixelWidths()), [])
    await sizedContext.close()
  }
  assert.deepEqual(errors, [])
  console.log(
    'Box Grid browser QA passed: four charts, code execution, playback, overlays, Scale bar, resize, Calculation 3D, mesh layout.',
  )
} finally {
  await browser?.close()
  await server.close()
}
