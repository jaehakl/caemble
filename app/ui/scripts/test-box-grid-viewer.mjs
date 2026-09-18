import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
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
      import { ViewerLayout } from '/src/features/viewer/viewer/ViewerTools.tsx';
      import { ViewerComparisonContext, createComparisonSettings } from '/src/features/viewer/viewer/comparisonSettings.tsx';
      import { createComparisonCamera } from '/src/features/viewer/viewer/comparisonCamera.ts';
      import { ComparisonToolbar } from '/src/features/viewer/viewer/ComparisonToolbar.tsx';
      import { ScalarPlot } from '/src/features/viewer/viewer/ScalarPlot.tsx';
      import { createPointCloudData } from '/src/features/viewer/viewer/pointCloudData.ts';
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
      const grid = { version:1,sampling:'cell-average',configuration:'current',weighting:'material-volume',components:['x','y','z'],channels:['amplitude','phase'],channelUnits:['m','rad'],origin:[0,0,0],size:[1,1,1],rotation:[[1,0,0],[0,1,0],[0,0,1]],lengthUnit:'m',gridShape:shape.slice(0,3),source:'task',rootId:'probe' };
      const values = Array.from({length:shape.reduce((a,b)=>a*b,1)},(_,i)=>Math.floor(i/3)%2 ? 0.3 : 1+(i%3)+Math.floor(i/6)*.01);
      const bytes=new Uint8Array(new Float64Array(values).buffer);
      const tensor={shape,axes:axes.map(({ticks})=>({ticks})),boxGrid:grid,storage:{kind:'base64',data:btoa(String.fromCharCode(...bytes)),byteLength:bytes.length}};
      const rule={label:'signal',result:{dtype:'float64',tensorOrder:1,unit:'m',axes:axes.map(({name,unit})=>({name,unit})),boxGrid:grid},methodId:'stored',parameters:{},target:[]};
      const layers=[{source:'experiment',lengthUnit:'m',parts:[{id:'body',geometry:modeling.primitives.cuboid({size:[.5,.5,.5],center:[.5,.5,.5]}),materialRole:'body',surfaces:[]}],tree:{key:'root',label:'Geometry',children:[]}}];
      const noop=()=>{}; const root=createRoot(document.getElementById('fixture'));
      window.leaf={dtype:'float64',shape,data:values,axes,tensorOrder:1,boxGrid:grid,unit:'m'};
      window.executeCopy = (code) => new Function('samples','boxGrid','return '+code)({signal:window.leaf},boxGrid);
      window.renderBox = (compatible=true)=>root.render(<BoxGridResult name="signal" rules={[rule]} data={{signal:tensor}} displayUnit="m" recordReference="samples['signal']" canOverlayGeometry={compatible} renderViewer={(data,geometryOpacity)=><JscadViewer layers={layers} lengthUnit="m" heatmapRenderData={data} geometryOpacity={geometryOpacity} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>}/>);
      window.renderComparison=()=>{
        const settings=createComparisonSettings(), camera=createComparisonCamera();
        root.render(<ViewerLayout><ComparisonToolbar camera={camera}/><div className="flex h-full">
          {['preview','actual'].map(side=><ViewerComparisonContext.Provider key={side} value={{settings,camera,item:'signal',side,controlsHost:null,controlsOwner:side==='actual',suspended:false}}>
            <div className="min-w-0 flex-1" data-comparison-pane={side}><BoxGridResult name="signal" rules={[rule]} data={{signal:tensor}} displayUnit="m" canOverlayGeometry renderViewer={(data,geometryOpacity)=><JscadViewer layers={layers} lengthUnit="m" heatmapRenderData={data} geometryOpacity={geometryOpacity} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>}/></div>
          </ViewerComparisonContext.Provider>)}
        </div></ViewerLayout>);
      };
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
        onFindSelectionSource={noop} onSelectionQueryChange={noop} onSelectionSourcePathsChange={noop} selectionQuery={null} selectionSourceStatus={{}}
      />);
      window.renderBox();
      window.renderRecordedRays=async({input,packet})=>{
        const {parseResultPolylines}=await import('/src/features/viewer/viewer/resultPolylines.ts');
        const {renderCanonicalGeometryScene}=await import('/src/lib/cad/execution/manifoldRender.ts');
        const {deserializeCadScene}=await import('/src/lib/cad/execution/mesh.ts');
        const {CadViewer}=await import('/src/features/viewer/viewer/CadViewer.tsx');
        const contracts={}, rules=[], data={};
        for(const [name,item] of Object.entries(packet.visualizations)){
          contracts[name]={...item.contract,schema:item.schema};
          for(const [member,schema] of Object.entries(item.schema)){
            const label=name+'.'+member; rules.push({label,result:schema,methodId:'stored',parameters:{},target:[]});data[label]=item.data[member];
          }
        }
        const parsed=parseResultPolylines(contracts,rules,data);
        if(parsed.errors.length)throw new Error(JSON.stringify(parsed.errors));
        const presentation=input.presentation.experiment;
        const serialized=await renderCanonicalGeometryScene(input.measurement.experiment.scene,{tree:presentation.tree,parts:presentation.materials});
          window.recordedRayStats={paths:parsed.bundles.reduce((sum,b)=>sum+b.pathCount,0),detectorHits:parsed.bundles.reduce((sum,b)=>sum+b.segmentEvent.filter(event=>event===5).length,0),refractions:parsed.bundles.reduce((sum,b)=>sum+b.segmentEvent.filter(event=>event===1).length,0)};
        root.render(<CadViewer key="recorded-rays" experiment={{scene:deserializeCadScene(serialized),sceneHash:serialized.sceneHash}} polylines={parsed.bundles} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>);
      };
      window.renderPixel=()=>{
        const shape=[2,2,1,1,2,1,1], values=[1,0,0,2,0,0,3,2];
        const axes=['x','y','z','time','frequency','amplitudePhase','component'].map((name,i)=>({name,ticks:[[.5,1.5],[.5,1.5],[.1],[0],[299792458/600e-9,299792458/500e-9],['value'],['value']][i],unit:i<3?'m':i===3?'s':i===4?'Hz':undefined}));
        const boxGrid={...grid,sampling:'surface-integral',configuration:undefined,weighting:undefined,frequencyKind:'source-sampled',components:['value'],channels:['value'],channelUnits:['W'],size:[2,2,.2],gridShape:shape.slice(0,3)};
        const bytes=new Uint8Array(new Float64Array(values).buffer);
        const tensor={shape,axes:axes.map(({ticks})=>({ticks})),boxGrid,storage:{kind:'base64',data:btoa(String.fromCharCode(...bytes)),byteLength:bytes.length}};
        window.leaf={dtype:'float64',shape,data:values,axes,tensorOrder:0,boxGrid,unit:'W'};
        root.render(<BoxGridResult key="pixels" name="signal" rules={[{...rule,result:{...rule.result,tensorOrder:0,unit:'W',axes:axes.map(({name,unit})=>({name,unit})),boxGrid}}]} data={{signal:tensor}} displayUnit="m" recordReference="samples['signal']" canOverlayGeometry={false} renderViewer={noop}/>);
      };

      window.renderRasterQA=({overlay=false,width=1280,height=720,nonuniform=false,range=[0,1],values: supplied}={})=>{
        const values=supplied ?? Array.from({length:width*height},(_,i)=>[1,width+3,511*width+511,512*width+512,width*height-1].includes(i)?1:0);
        const plot={axes:[{name:'y',ticks:Array.from({length:height},(_,i)=>i+.5)},{name:'x',ticks:Array.from({length:width},(_,i)=>nonuniform?i*i+.5:i+.5)}],shape:[height,width],values,range};
        const leaf={...window.leaf,boxGrid:{...grid,origin:[0,0,0],size:[width,height,1]}};
        window.qaPlot=plot;
        window.qaRaster=createPointCloudData(plot,{identity:'qa-raster',leaf,range,plane:{axis:2,coordinate:.5}}).raster;
        root.render(<React.StrictMode>{overlay?<JscadViewer key="raster-qa" layers={[]} lengthUnit="m" heatmapRenderData={{identity:'qa-raster',geometries:[],raster:window.qaRaster,bounds:{min:[0,0,0],max:[width,height,1]}}} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>:<ScalarPlot key="raster-qa" plot={plot} kind="heatmap" range={range} unit="W"/>}</React.StrictMode>);
      };
      window.verifyNativeRaster=()=>{
        const canvas=document.querySelector('canvas[aria-label="heatmap 차트"]');
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        const viewport=canvas.parentElement.parentElement, raster=window.qaRaster;
        let checked=0,signals=0,mismatches=0;
        const dpr=window.devicePixelRatio;
        for(let row=0;row<raster.height;row++)for(let col=0;col<raster.width;col++){
          const x=Math.floor((75+col+.5-viewport.scrollLeft)*dpr), y=Math.floor((25+raster.height-row-.5-viewport.scrollTop)*dpr);
          if(x<0||y<0||x>=canvas.width||y>=canvas.height)continue;
          checked++; const source=(row*raster.width+col)*4, target=(y*canvas.width+x)*4;
          if(raster.rgba[source]||raster.rgba[source+1])signals++;
          if([0,1,2,3].some(c=>pixels[target+c]!==raster.rgba[source+c]))mismatches++;
        }
        return {checked,signals,mismatches};
      };

      window.renderRecordedSensor=()=>{
        const raster=window.recordedSumRaster;
        const corners=[[0,0],[0,1],[1,0],[1,1]].map(([c,r])=>raster.origin.map((v,i)=>v+c*raster.columnVector[i]+r*raster.rowVector[i]));
        const bounds={min:[0,1,2].map(i=>Math.min(...corners.map(p=>p[i]))),max:[0,1,2].map(i=>Math.max(...corners.map(p=>p[i])))};
        root.render(<JscadViewer layers={[]} lengthUnit="mm" heatmapRenderData={{identity:'recorded-sensor',geometries:[],raster,bounds}} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>);
      };
      window.renderRecordedHeatmap=async()=>{
        const {input,record}=await (await fetch('/recorded-heatmap-fixture')).json();
        const {renderCanonicalGeometryScene}=await import('/src/lib/cad/execution/manifoldRender.ts');
        const {deserializeCadScene}=await import('/src/lib/cad/execution/mesh.ts');
        const {CadViewer}=await import('/src/features/viewer/viewer/CadViewer.tsx');
        const presentation=input.presentation.experiment;
        const serialized=await renderCanonicalGeometryScene(input.measurement.experiment.scene,{tree:presentation.tree,parts:presentation.materials});
        const scene=deserializeCadScene(serialized);
        root.render(<React.StrictMode><BoxGridResult key="recorded-heatmap" name={record.name}
          rules={[{label:record.name,result:record.schema,methodId:'stored',parameters:{},target:[]}]} data={{[record.name]:record.value}}
          displayUnit="mm" recordReference="samples['detectorPower']" canOverlayGeometry={true}
          renderViewer={(data,geometryOpacity)=>{window.qaRaster=data.raster;return <CadViewer experiment={{scene,sceneHash:serialized.sceneHash}} heatmapRenderData={data} geometryOpacity={geometryOpacity} onRenderStart={noop} onRenderEnd={noop} onRenderError={message=>{throw new Error(message)}}/>;}}/>
        </React.StrictMode>);
      };
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
          if (req.url === '/recorded-heatmap-fixture' && process.env.CAEMBLE_VIEWER_HEATMAP_RESULT) {
            const directory = path.resolve(process.env.CAEMBLE_VIEWER_HEATMAP_RESULT)
            const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
            const entry = manifest.records.find((record) => record.name === 'detectorPower')
            const record = JSON.parse(await readFile(path.join(directory, entry.path), 'utf8'))
            const buffers = await Promise.all(
              record.attachments.map((attachment) => readFile(path.join(directory, attachment.path))),
            )
            record.value.storage = {
              kind: 'base64',
              data: Buffer.concat(buffers).toString('base64'),
              byteLength: record.value.storage.byteLength,
            }
            const input = JSON.parse(await readFile(manifest.input, 'utf8'))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ input, record }))
            return
          }
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
      .getByRole('button', { name: '변환 코드 복사', exact: true })
      .waitFor()
      .then(() => page.waitForFunction(() => !document.querySelector('button[aria-label="변환 코드 복사"]').disabled))
  const open = async (name) => {
    const button = page.getByRole('button', { name, exact: true })
    if ((await button.count()) && (await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  }
  const role = async (axis, value) => {
    await open(`${{ time: 't', frequency: 'f' }[axis] ?? axis} 축 역할`)
    await page.getByRole('combobox', { name: `${axis} 역할`, exact: true }).selectOption(value)
    await ready()
  }
  const closePanels = async () => {
    const buttons = page.locator('[aria-orientation="vertical"] button[aria-expanded="true"]')
    while (await buttons.count()) await buttons.first().click()
  }
  const setRange = async (label, value) =>
    page.getByRole('slider', { name: label, exact: true }).evaluate((input, next) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
  await ready()
  await mkdir('node_modules/.tmp/viewer-qa', { recursive: true })
  assert.equal(
    await page.getByRole('button', { name: '3D Point cloud', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(await page.getByRole('button', { name: 'Viewer 확장', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('표본 조회').count(), 0)
  assert.equal(await page.getByText(/표본 표시/).count(), 0)
  const initialCanvas = await page.locator('[data-viewer-canvas]').boundingBox()
  await open('Geometry 투명도')
  await open('comp 축 역할')
  await open('f 축 역할')
  assert.deepEqual(
    await page.locator('[data-viewer-canvas]').boundingBox(),
    initialCanvas,
    'Popovers must not resize the canvas',
  )
  assert.equal(await page.getByRole('slider', { name: 'Geometry 투명도', exact: true }).inputValue(), '0.5')
  assert.equal(await page.getByLabel('성분', { exact: true }).inputValue(), 'magnitude')
  assert.equal(await page.getByLabel('frequency 역할').inputValue(), 'sum')
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/default-cloud.png' })
  await page.getByRole('button', { name: 'Geometry 투명도', exact: true }).click()
  assert.equal(await page.getByRole('slider', { name: 'Geometry 투명도', exact: true }).count(), 0)
  await closePanels()
  await role('z', 'index')
  assert.equal(await page.getByRole('button', { name: 'Heatmap', exact: true }).getAttribute('aria-pressed'), 'true')
  await role('y', 'index')
  assert.equal(await page.getByRole('button', { name: 'Line Chart', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '변환 코드 복사', exact: true }).click()
  const line = await page.evaluate(async () => window.executeCopy(await navigator.clipboard.readText()))
  assert.deepEqual(
    line.axes.map((axis) => axis.ticks.length),
    [4],
  )
  await role('x', 'mean')
  assert.equal(await page.getByRole('button', { name: 'Histogram', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByLabel('집계 결과값').waitFor()
  await page.getByRole('button', { name: '변환 코드 복사', exact: true }).click()
  const scalar = await page.evaluate(async () => window.executeCopy(await navigator.clipboard.readText()))
  assert.deepEqual(scalar.axes, [])
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/histogram-marker.png' })
  await role('x', 'space')
  await role('y', 'space')
  await role('z', 'space')
  await open('comp 축 역할')
  await page.getByLabel('성분', { exact: true }).selectOption('arrows')
  await role('time', 'mean')
  await role('frequency', 'mean')
  await open('채널 축 역할')
  await page.getByLabel('채널', { exact: true }).selectOption('oscillation')
  await setRange('Animation 프레임', 0.025)
  await ready()
  await page.getByRole('button', { name: '변환 코드 복사', exact: true }).click()
  const synthesized = await page.evaluate(async () => {
    const code = await navigator.clipboard.readText()
    return { code, outputs: code.split('\n').map(window.executeCopy) }
  })
  assert.equal(synthesized.outputs.length, 4)
  assert.ok(synthesized.code.includes('"timeSeconds":0.025'))
  const expected = await page.evaluate(() => {
    const components = [0, 0, 0],
      magnitudes = []
    for (let t = 0; t < 2; t++) {
      const vector = [0, 1, 2].map((c) => {
        let total = 0
        for (let f = 0; f < 2; f++) {
          const offset = (t * 2 + f) * 6
          total +=
            window.leaf.data[offset + c] * Math.cos(window.leaf.data[offset + 3 + c] + 2 * Math.PI * [0, 10][f] * 0.025)
        }
        return total / 2
      })
      vector.forEach((value, c) => {
        components[c] += value / 2
      })
      magnitudes.push(Math.hypot(...vector))
    }
    return { components, magnitude: (magnitudes[0] + magnitudes[1]) / 2 }
  })
  synthesized.outputs
    .slice(0, 3)
    .forEach((output, c) => assert.ok(Math.abs(output.data[0][0][0] - expected.components[c]) < 1e-10))
  assert.ok(Math.abs(synthesized.outputs[3].data[0][0][0] - expected.magnitude) < 1e-10)
  await page.getByRole('button', { name: '시간 전개 재생', exact: true }).click()
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Animation 프레임"]').value) !== 0.025)
  await page.getByRole('button', { name: '시간 전개 일시정지', exact: true }).click()
  await ready()
  await closePanels()
  await role('z', 'index')
  await role('time', 'index')
  await role('frequency', 'index')
  const boxes = await page.locator('[data-viewer-floating-panel]').evaluateAll((panels) =>
    panels
      .map((panel) => {
        const { top, bottom } = panel.getBoundingClientRect()
        return { top, bottom }
      })
      .sort((a, b) => a.top - b.top),
  )
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].bottom, 'Popovers must not overlap')
  await setRange('frequency index', 1)
  await ready()
  await page.getByRole('button', { name: 'f 축 역할', exact: true }).click()
  assert.equal(await page.getByRole('slider', { name: 'frequency index', exact: true }).count(), 0)
  await open('f 축 역할')
  assert.equal(await page.getByRole('slider', { name: 'frequency index', exact: true }).inputValue(), '1')
  await page.getByRole('button', { name: '값 범위 고정', exact: true }).click()
  assert.equal(await page.getByLabel('값 colorbar').count(), 1)
  await page.getByLabel('범위 최솟값').fill('-2')
  await page.getByLabel('범위 최댓값').fill('3')
  await page.getByLabel('범위 최솟값').fill('4')
  await page.getByRole('alert').filter({ hasText: '마지막 유효 범위' }).waitFor()
  await page.getByLabel('범위 최솟값').fill('3')
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.getByRole('button', { name: '값 범위 고정', exact: true }).click()
  assert.equal(await page.getByLabel('값 colorbar').count(), 0)
  await page.setViewportSize({ width: 480, height: 600 })
  await ready()
  const narrow = await page.locator('[data-viewer-canvas]').boundingBox()
  await open('Geometry 투명도')
  assert.deepEqual(await page.locator('[data-viewer-canvas]').boundingBox(), narrow)
  assert.ok(narrow.width > 400)
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/narrow.png' })
  await page.setViewportSize({ width: 850, height: 650 })
  await page.evaluate(() => window.renderComparison())
  await page.waitForFunction(() => document.querySelectorAll('[data-viewer-canvas]').length === 2)
  assert.equal(await page.getByRole('toolbar', { name: 'Viewer 공통 툴바', exact: true }).count(), 1)
  assert.equal(await page.getByRole('toolbar', { name: '데이터 도구모음', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Set z camera view', exact: true }).count(), 1)
  const spatialBorder = await page
    .getByRole('combobox', { name: 'x 역할', exact: true })
    .evaluate((node) => getComputedStyle(node.parentElement).borderColor)
  const statisticBorder = await page
    .getByRole('combobox', { name: 'frequency 역할', exact: true })
    .evaluate((node) => getComputedStyle(node.parentElement).borderColor)
  assert.notEqual(spatialBorder, statisticBorder, 'Axis roles need distinct visible border colors')
  const paneSizes = await page
    .locator('[data-comparison-pane]')
    .evaluateAll((nodes) => nodes.map((node) => [node.clientWidth, node.clientHeight]))
  await role('frequency', 'index')
  await role('time', 'index')
  assert.deepEqual(
    await page
      .locator('[data-comparison-pane]')
      .evaluateAll((nodes) => nodes.map((node) => [node.clientWidth, node.clientHeight])),
    paneSizes,
  )
  const comparisonPanels = await page.locator('[data-viewer-floating-panel]').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
      })
      .sort((a, b) => a.top - b.top),
  )
  for (let i = 1; i < comparisonPanels.length; i++) assert.ok(comparisonPanels[i].top >= comparisonPanels[i - 1].bottom)
  assert.ok(comparisonPanels.every((panel) => panel.left >= 44 && panel.right <= 850))
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/comparison.png' })
  await page.evaluate(() => window.renderCalculation())
  await page.waitForSelector('[data-result-visualization="point-cloud"] canvas')
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/calculation-3d.png' })
  await page.evaluate(() => window.renderLargeBox())
  await page.getByRole('button', { name: 'Histogram', exact: true }).click()
  await page.getByRole('button', { name: 'Line Chart', exact: true }).click()
  await ready()
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.evaluate(() => window.renderMesh())
  await page.locator('[data-viewer-canvas]').waitFor()
  assert.ok((await page.locator('[data-viewer-canvas]').boundingBox()).height > 350)
  await page.setViewportSize({ width: 1200, height: 850 })
  await page.evaluate(() => window.renderWorkbench())
  await ready()
  assert.equal(await page.getByRole('button', { name: '표시 데이터 종류 변경 · signal', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).isEnabled(), true)
  await role('z', 'index')
  await role('time', 'space')
  assert.equal(await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).isDisabled(), true)
  await role('time', 'index')
  await role('z', 'space')
  for (const mismatch of ['source', 'vars']) {
    await page.evaluate((value) => window.renderWorkbench(value), mismatch)
    await ready()
    assert.equal(await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).isDisabled(), true)
  }
  await page.evaluate(() => window.renderWorkbench())
  await ready()
  assert.equal(await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).isEnabled(), true)
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
    assert.equal(await sizedPage.getByText(/표본 표시/).count(), 0)
    await sizedPage.screenshot({ path: `node_modules/.tmp/viewer-qa/point-area-${deviceScaleFactor}x.png` })
    await sizedPage.evaluate(() => window.renderSizedCalculation([0, 0, 0, 0]))
    await sizedPage.waitForFunction(async () => (await window.pointPixelWidths()).length === 0)
    assert.deepEqual(await sizedPage.evaluate(() => window.pointPixelWidths()), [])
    await sizedPage.evaluate(() =>
      window.renderRasterQA({ width: 2, height: 2, values: [-1, 0, 1, 0], range: [-1, 1] }),
    )
    await sizedPage.getByRole('button', { name: '원본 크기', exact: true }).click()
    await sizedPage.waitForFunction(
      () => window.verifyNativeRaster().checked === 4 && window.verifyNativeRaster().mismatches === 0,
    )
    await sizedContext.close()
  }
  await page.evaluate(() => window.renderPixel())
  await ready()
  assert.equal(await page.getByRole('button', { name: 'Heatmap', exact: true }).getAttribute('aria-pressed'), 'true')
  await open('f 축 역할')
  assert.equal(await page.getByLabel('frequency 역할').inputValue(), 'index')
  assert.ok((await page.locator('body').innerText()).includes('픽셀 적분 전력 [W]'))
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/pixel-image.png' })
  await setRange('frequency index', 1)
  await ready()
  await page.getByLabel('주파수 표시 단위').selectOption('Hz')
  await ready()
  await role('y', 'sum')
  await role('frequency', 'space')
  await page.getByRole('button', { name: 'Line Chart', exact: true }).click()
  await ready()
  await page.getByLabel('주파수 표시 단위').selectOption('nm')
  await ready()
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/pixel-profile.png' })

  // Native mode must reproduce every source pixel, including impulses missed by the old strides.
  await page.setViewportSize({ width: 2000, height: 1400 })
  await page.evaluate(() => window.renderRasterQA())
  await page.getByRole('button', { name: '원본 크기', exact: true }).click()
  await page.waitForFunction(() => window.verifyNativeRaster().checked === 1280 * 720)
  assert.deepEqual(await page.evaluate(() => window.verifyNativeRaster()), {
    checked: 1280 * 720,
    signals: 5,
    mismatches: 0,
  })
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/heatmap-native-sparse.png' })
  await page.setViewportSize({ width: 800, height: 500 })
  await page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="heatmap 차트"]')
    c.parentElement.parentElement.scrollTo(500, 250)
  })
  await page.waitForFunction(() => window.verifyNativeRaster().mismatches === 0)
  assert.ok((await page.evaluate(() => window.verifyNativeRaster())).checked < 1280 * 720)
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await page.setViewportSize({ width: 2000, height: 1400 })
  // Exercise both the 2048-pixel tile seam and the short final tile.
  await page.evaluate(() =>
    window.renderRasterQA({
      width: 2051,
      height: 3,
      values: Array.from({ length: 2051 * 3 }, (_, i) => ([2047, 2048, 2050, 4100].includes(i) ? 1 : 0)),
    }),
  )
  await page.getByRole('button', { name: '원본 크기', exact: true }).click()
  await page.evaluate(() => {
    document.querySelector('canvas[aria-label="heatmap 차트"]').parentElement.parentElement.scrollTo(500, 0)
  })
  await page.waitForFunction(
    () => window.verifyNativeRaster().signals === 4 && window.verifyNativeRaster().mismatches === 0,
  )
  for (const values of [
    [-1, 0, 1, 0],
    [0, 0, 0, 0],
  ]) {
    await page.evaluate(
      (values) =>
        window.renderRasterQA({ width: 2, height: 2, values, range: values.some((v) => v) ? [-1, 1] : [0, 0] }),
      values,
    )
    await page.waitForFunction(
      () => window.verifyNativeRaster().checked === 4 && window.verifyNativeRaster().mismatches === 0,
    )
  }
  await page.evaluate(() => window.renderRasterQA({ overlay: true }))
  await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/heatmap-texture-sparse.png' })
  await page.evaluate(() => window.renderRasterQA({ overlay: true, width: 2051, height: 3 }))
  await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
  await page.evaluate(() =>
    window.renderRasterQA({ nonuniform: true, width: 3, height: 2, values: [0, 1, 0, 1, 0, 1] }),
  )
  await page.getByRole('button', { name: '화면 맞춤', exact: true }).click()
  await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/heatmap-nonuniform.png' })
  assert.deepEqual(
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas[aria-label="heatmap 차트"]'),
        ctx = canvas.getContext('2d')
      // x ticks [.5,1.5,4.5] have edges [0,1,3,6]; row zero is the bottom row.
      const colors = []
      for (const row of [0, 1])
        for (const x of [0.5, 2, 4.5])
          colors.push([
            ...ctx.getImageData(
              Math.floor(75 + ((canvas.width - 100) * x) / 6),
              Math.floor(25 + (canvas.height - 90) * (1 - (row + 0.5) / 2)),
              1,
              1,
            ).data,
          ])
      return colors
    }),
    [
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
    ],
  )
  // Verify actual GPU texture orientation and exact colors, including zero and a negative value.
  await page.evaluate(() =>
    window.renderRasterQA({ overlay: true, width: 2, height: 2, values: [-1, 0, 0.5, 1], range: [-1, 1] }),
  )
  await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
  assert.deepEqual(
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const canvas = document.querySelector('canvas'),
        gl = canvas.getContext('webgl')
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      let minX = canvas.width,
        minY = canvas.height,
        maxX = 0,
        maxY = 0
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4,
            rgb = pixels.subarray(i, i + 3)
          if (Math.max(...rgb) - Math.min(...rgb) > 100) {
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
          }
        }
      return [0.25, 0.75].flatMap((y) =>
        [0.25, 0.75].map((x) => {
          const i = (Math.floor(minY + (maxY - minY) * y) * canvas.width + Math.floor(minX + (maxX - minX) * x)) * 4
          return [...pixels.subarray(i, i + 4)]
        }),
      )
    }),
    [
      [0, 0, 255, 255],
      [0, 255, 0, 255],
      [128, 128, 0, 255],
      [255, 0, 0, 255],
    ],
  )

  if (process.env.CAEMBLE_VIEWER_HEATMAP_RESULT) {
    await page.evaluate(() => window.renderRecordedHeatmap())
    await ready()
    await role('frequency', 'sum')
    await ready()
    await page.waitForFunction(() => window.qaRaster?.width === 1280)
    const signals = await page.evaluate(() => {
      let count = 0
      const { rgba } = window.qaRaster
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i] || rgba[i + 1]) count++
      return count
    })
    assert.equal(signals, 1303)
    await page.evaluate(() => {
      window.recordedSumRaster = window.qaRaster
    })
    await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
    await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/spectrometer-heatmap-overlay.png' })
    await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).click()
    await page.getByRole('button', { name: '원본 크기', exact: true }).click()
    await page.waitForFunction(() => window.verifyNativeRaster().checked === 1280 * 720)
    assert.deepEqual(await page.evaluate(() => window.verifyNativeRaster()), {
      checked: 1280 * 720,
      signals: 1303,
      mismatches: 0,
    })
    await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/spectrometer-heatmap-native.png' })
    await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).click()
    await page.getByRole('button', { name: '값 범위 고정', exact: true }).click()
    await page.getByLabel('범위 최댓값').fill('0.05')
    await ready()
    await role('frequency', 'index')
    await setRange('frequency index', 2)
    await ready()
    await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).click()
    await page.getByRole('button', { name: '원본 크기', exact: true }).click()
    await page.waitForFunction(() => window.verifyNativeRaster().mismatches === 0)
    await page.getByRole('button', { name: 'Geometry 겹치기', exact: true }).click()
    await role('frequency', 'index')
    await page.getByRole('button', { name: 'f 재생', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="Animation 프레임"]').value) > 0)
    await page.getByRole('button', { name: 'f 일시정지', exact: true }).click()
    await ready()
    await page.evaluate(() => window.renderRecordedSensor())
    await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
    await page.screenshot({ path: 'node_modules/.tmp/viewer-qa/spectrometer-heatmap-sensor.png' })
    console.log(
      'Saved spectrometer Heatmap: 1303 signals, 921600 native pixels verified against overlay texture bytes.',
    )
  }
  if (process.env.CAEMBLE_VIEWER_RAY_RESULT) {
    const directory = path.resolve(process.env.CAEMBLE_VIEWER_RAY_RESULT)
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    const packet = JSON.parse(await readFile(path.join(directory, manifest.visualizations[0].path), 'utf8'))
    const input = JSON.parse(await readFile(manifest.input, 'utf8'))
    await page.evaluate((fixture) => window.renderRecordedRays(fixture), { input, packet })
    const expectedPaths = manifest.trace[0].observations.recordedPaths
    await page.getByText(new RegExp('Polylines · ' + expectedPaths + ' paths')).waitFor()
    const stats = await page.evaluate(() => window.recordedRayStats)
    assert.equal(stats.paths, expectedPaths)
    assert.ok(stats.detectorHits > 0)
    const transmission = manifest.records.some((record) => record.name === 'transmittedPower')
    if (transmission) assert.ok(stats.refractions > 0)
    await page
      .getByRole('button', { name: transmission ? 'Set y camera view' : 'Set z camera view', exact: true })
      .click()
    await page.screenshot({
      path: 'node_modules/.tmp/viewer-qa/recorded-' + (transmission ? 'transmission' : 'pixel') + '-rays.png',
    })
    console.log('Recorded pixel paths in Viewer:', stats)
  }
  assert.deepEqual(errors, [])
  console.log(
    'Box Grid browser QA passed: four charts, code execution, playback, overlays, fixed range, narrow and comparison layouts, Calculation 3D, mesh layout.',
  )
} finally {
  await browser?.close()
  await server.close()
}
