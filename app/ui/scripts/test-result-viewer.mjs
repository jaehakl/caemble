import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Reopen a real local structural-optical-results execution, including attachments.
const directory = path.resolve(process.argv[2])
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
assert.equal(manifest.state, 'succeeded')
const input = JSON.parse(await readFile(path.resolve(directory, manifest.input), 'utf8'))
const contracts = input.measurement.experiment.simulationProgram.resultContracts
const schemas = {},
  records = {}
for (const record of manifest.records) {
  const stored = JSON.parse(await readFile(path.join(directory, record.path), 'utf8'))
  schemas[record.name] = record.schema
  records[record.name] = stored.value
  const attachments = new Map(
    await Promise.all(
      record.attachments.map(async (item) => [item.id, await readFile(path.join(directory, item.path))]),
    ),
  )
  const pending = [stored.value]
  while (pending.length) {
    const value = pending.pop()
    if (value.storage?.kind === 'attachments') {
      const bytes = Buffer.concat(value.storage.ids.map((id) => attachments.get(id)))
      value.storage = { kind: 'base64', data: bytes.toString('base64'), byteLength: bytes.length }
    } else if (!value.storage) pending.push(...Object.values(value))
  }
}
const server = await createServer({
  server: { port: 0, host: '127.0.0.1' },
  plugins: [
    {
      name: 'result-viewer-fixture',
      resolveId(id) {
        if (id === '/result-fixture.tsx') return '\0result-fixture'
      },
      load(id) {
        if (id !== '\0result-fixture') return
        return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import modeling from '@jscad/modeling';
        import { WorkbenchViewer } from '/src/features/cae-workbench/viewer/WorkbenchViewer.tsx';
        import { ResultTensorView } from '/src/features/viewer/viewer/ResultTensorView.tsx';
        import { recordedDataRules, flattenRecordedData } from '/src/lib/cad/simulation/recordedData.ts';
        import { materialVarsHash } from '/src/lib/material/resolution.ts';
        import { createCalculationInput } from '/src/lib/calculation/input.ts';
        import '/src/index.css';
        const fixture = window.fixture;
        const rules = recordedDataRules(fixture.schemas, 'saved');
        const data = flattenRecordedData(fixture.schemas, fixture.records);
        // Reading a leaf for Calculation needs only its frozen schema, even with no Catalog installed.
        const leaves = rules.filter(rule => rule.label === 'displacement.values' || rule.label === 'detectorPower');
        const calculation = createCalculationInput(leaves, data);
        window.calculationLeaves = Object.keys(calculation);
        const scene = { lengthUnit: 'mm', parts: [{ id: 'base', geometry: modeling.primitives.cuboid({size:[60,8,8],center:[0,0,-20]}), materialRole:'base', surfaces:[] }], tree:{key:'root',label:'Geometry',children:[]}, geometryGroups:[],surfaceGroups:[] };
        const noop = () => {};
        const props = { experiment:{}, experimentDocument:{ scene,sceneHash:'fixture',taskScenes:{},evaluatedSnapshot:{sourceHash:fixture.sourceHash,variables:fixture.variables},handleRenderStart:noop,handleRenderEnd:noop,handleRenderError:(message)=>{throw new Error(message)} }, resultContracts:fixture.contracts,resultSourceHash:fixture.sourceHash,resultVarsHash:materialVarsHash(fixture.variables),recordedRules:rules,recordedData:data,onFindSelectionSource:noop,onSelectionQueryChange:noop,onSelectionSourcePathsChange:noop,onToggleViewerExpanded:noop,selectionQuery:null,selectionSourceStatus:{},viewerExpanded:false };
        const root = createRoot(document.getElementById('fixture'));
        window.renderResult = (key='first', mismatch=false) => root.render(React.createElement(WorkbenchViewer,{...props,key,resultSourceHash:mismatch?'different':fixture.sourceHash}));
        window.renderStructured = () => {
          const contract = {...fixture.contracts.detectorPower,visualization:{kind:'structured-field',spatialAxes:[1,2,3]}};
          const schema = {dtype:'float64',tensorOrder:0,quantityKind:'Dimensionless',unit:'1',axes:[{name:'time'},{name:'x'},{name:'y'},{name:'z'},{name:'component'}]};
          const value = Array.from({length:2},(_,t)=>Array.from({length:2},(_,x)=>Array.from({length:2},(_,y)=>Array.from({length:2},(_,z)=>Array.from({length:3},(_,c)=>t*24+x*12+y*6+z*3+c)))));
          root.render(React.createElement(ResultTensorView,{name:'spatial',contract,rules:[{label:'spatial',result:schema,methodId:'stored',parameters:{},target:[]}],data:{spatial:{shape:[2,2,2,2,3],axes:[{ticks:[0,1]},{ticks:[0,1]},{ticks:[0,1]},{ticks:[0,1]},{ticks:[0,1,2]}],storage:{kind:'inline',value}}}}));
        };
        window.renderResult();
      `
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/result-fixture') return next()
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(
            await server.transformIndexHtml(
              '/result-fixture',
              '<html><body><div id="fixture" style="height:900px"></div><script type="module" src="/result-fixture.tsx"></script></body></html>',
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.stack))
  await page.addInitScript(
    (fixture) => {
      window.fixture = fixture
    },
    { schemas, records, contracts, sourceHash: manifest.sourceHash, variables: input.measurement.experiment.variables },
  )
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/result-fixture`)
  const select = page.getByLabel('Viewer 결과 선택')
  await select.waitFor()
  assert.equal(await select.inputValue(), '')
  assert.equal(await select.locator('option').count(), 7)
  assert.deepEqual(await page.evaluate(() => window.calculationLeaves), ['displacement.values', 'detectorPower'])
  await select.selectOption('stress')
  await page.getByLabel('stress field component').waitFor()
  assert.equal(await page.getByLabel('stress field component').inputValue(), 'vonMises')
  const plain = await page.locator('canvas').screenshot()
  await page.getByLabel('opticalTrajectories Overlay').check()
  await page.getByLabel('secondaryTrajectories Overlay').check()
  await page.getByText(/Polylines/).waitFor()
  const overlay = await page.locator('canvas').screenshot()
  assert.ok(!plain.equals(overlay), 'Path overlays must change the WebGL image.')
  await page.screenshot({ path: 'node_modules/.tmp/result-overlay.png' })
  await select.selectOption('displacement')
  await page.getByLabel('displacement displacement scale').fill('2')
  await page.getByText(/변형 표시 중에는/).waitFor()
  assert.equal(await page.getByText(/Polylines/).count(), 0)
  await select.selectOption('opticalTrajectories')
  await page.getByText(/Polylines/).waitFor()
  await select.selectOption('reaction')
  assert.equal(await page.getByLabel('reaction displacement scale').count(), 0)
  await select.selectOption('detectorPower')
  await page.locator('[data-result-visualization="tensor"]').waitFor()
  await page.evaluate(() => window.renderResult('second'))
  assert.equal(await select.inputValue(), '')
  assert.equal(await page.getByLabel('opticalTrajectories Overlay').isChecked(), false)
  await page.evaluate(() => window.renderResult('third', true))
  await select.selectOption('stress')
  assert.equal(await page.getByLabel('opticalTrajectories Overlay').isDisabled(), true)
  await page.getByText(/source 또는 Vars 좌표가 달라/).waitFor()
  await page.evaluate(() => window.renderStructured())
  await page.getByLabel('축 0 index').waitFor()
  const firstSlice = await page.locator('[data-result-visualization="structured-field"]').screenshot()
  await page.getByLabel('축 0 index').fill('1')
  await page.getByLabel('축 4 index').fill('2')
  const nextSlice = await page.locator('[data-result-visualization="structured-field"]').screenshot()
  assert.ok(!firstSlice.equals(nextSlice), 'Selecting time and component must update the rendered slice.')
  assert.deepEqual(errors, [])
  assert.equal(await page.getByRole('alert').count(), 0)
  console.log(
    'Saved multi-solver results, Calculation leaf access, common WebGL overlays, deformation guard, coordinate mismatch and Measurement reset passed.',
  )
} finally {
  await browser?.close()
  await server.close()
}
