import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const points = Array.from({ length: 8 }, (_, index) => [index & 1, (index >> 1) & 1, (index >> 2) & 1])
const cells = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
]
const faces = new Map()
for (let cell = 0; cell < cells.length; cell += 1) {
  for (const face of [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ]) {
    const nodes = face.map((index) => cells[cell][index])
    const key = [...nodes].sort((a, b) => a - b).join(',')
    if (faces.has(key)) faces.delete(key)
    else faces.set(key, { nodes, cell })
  }
}
const boundary = [...faces.values()]
const field = {
  label: 'Displacement',
  identity: 'browser-mesh-fixture',
  task: 'structure',
  coordinateSpace: 'experiment',
  nodeIds: points.map((_, index) => index),
  lengthUnit: 'm',
  valueUnit: 'm',
  quantity: 'kinematics.Displacement',
  valueKind: 'displacement',
  location: 'node',
  points: points.flat(),
  cells: cells.flat(),
  values: points.flatMap(([x, y, z]) => [x * 0.1, y * 0.05, z * 0.01]),
  componentCount: 3,
  components: ['x', 'y', 'z'],
  boundaryFaces: boundary.flatMap(({ nodes }) => nodes),
  boundaryCells: boundary.map(({ cell }) => cell),
  cellRegions: [0, 0, 0, 1, 1, 1],
  regionIds: ['Steel', 'Aluminum'],
  supportNodes: [0, 2, 4, 6],
  loadPoints: [[1, 0.5, 0.5]].flat(),
  loadVectors: [1, 0, 0],
}
const harmonicDisplacement = {
  ...field,
  label: 'Harmonic displacement',
  values: [...field.values, ...field.values.map((value) => value * 0.5)],
  spectrum: {
    frequencies: [40, 90],
    imaginaryValues: [...field.values.map((value) => value * 0.75), ...field.values.map((value) => value * 2)],
  },
}
const harmonicStress = {
  ...field,
  label: 'Harmonic stress',
  valueKind: 'stress',
  valueUnit: 'Pa',
  quantity: 'mechanics.Stress',
  location: 'cell',
  componentCount: 6,
  components: ['xx', 'yy', 'zz', 'xy', 'yz', 'xz'],
  values: [2, 1].flatMap((scale) => cells.flatMap((_, index) => [scale * (10 + index), 0, 0, 0, 0, 0])),
  spectrum: {
    // Intentionally different order: deformation must match Hz, not the sample index.
    frequencies: [90, 40],
    imaginaryValues: [2, 1].flatMap((scale) => cells.flatMap((_, index) => [0, 0, 0, scale * (5 + index), 0, 0])),
  },
}
const pressure = {
  ...field,
  label: 'Harmonic pressure',
  task: 'acoustics',
  identity: 'air-mesh-fixture',
  valueKind: undefined,
  valueUnit: 'Pa',
  quantity: 'Pressure',
  componentCount: 1,
  components: ['pressure'],
  values: [...points.map(() => 2), ...points.map(() => 0)],
  spectrum: { frequencies: [40, 90], imaginaryValues: [...points.map(() => 0), ...points.map(() => 4)] },
  supportNodes: [],
  loadPoints: [],
  loadVectors: [],
}
const fixtures = {
  static: field,
  transient: {
    ...field,
    label: 'Transient displacement',
    times: [0, 0.2, 0.7],
    timeUnit: 's',
    historyValues: [0, 1, -0.5].flatMap((scale) => field.values.map((value) => value * scale)),
  },
  displacement: harmonicDisplacement,
  stress: harmonicStress,
  pressure,
}
const serverOnly = process.env.CAEMBLE_MESH_FIXTURE_ONLY === '1'
const fixturePort = Number(process.env.CAEMBLE_MESH_FIXTURE_PORT ?? 0)
const resultLocation = process.env.CAEMBLE_MESH_FIXTURE_RESULT
let savedResult
const savedAttachments = new Map()
assert.ok(Number.isInteger(fixturePort) && fixturePort >= 0 && fixturePort <= 65535, 'Fixture port must be 0–65535.')
const server = await createServer({
  server: { port: fixturePort, strictPort: fixturePort !== 0, host: '127.0.0.1' },
  clearScreen: false,
  plugins: [
    {
      name: 'mesh-viewer-browser-fixture',
      resolveId(id) {
        if (id === '/mesh-fixture.tsx') return '\0mesh-fixture-entry'
      },
      load(id) {
        if (id === '\0mesh-fixture-entry')
          return `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MeshFieldResult } from '/src/features/viewer/viewer/MeshFieldResult.tsx';
      import { MeshTransformResult } from '/src/features/viewer/viewer/MeshTransformResult.tsx';
      import { parseRecordedMeshTransforms } from '/src/features/viewer/viewer/meshTransforms.ts';
      import { parseRecordedParticleSets } from '/src/features/viewer/viewer/particleSets.ts';
      import JscadViewer from '/src/features/viewer/viewer/JscadViewer.tsx';
      import { WorkbenchViewer } from '/src/features/cae-workbench/viewer/WorkbenchViewer.tsx';
      import { visualizationData } from '/src/features/viewer/viewer/visualizationData.ts';
      import { parseRecordedMeshFields } from '/src/features/viewer/viewer/meshFields.ts';
      import { registerDataTensorAttachment } from '/src/lib/cad/model/dataTensor.ts';
      import '/src/index.css';
      const fixtures = ${JSON.stringify(fixtures)};
      const normalize = (field) => {
        const result = {...field};
        for (const key of ['points', 'values', 'loadPoints', 'loadVectors', 'times', 'historyValues'])
          if (field[key]) result[key] = Float64Array.from(field[key]);
        for (const key of ['cells', 'boundaryFaces', 'boundaryCells', 'cellRegions', 'supportNodes'])
          result[key] = Uint32Array.from(field[key]);
        if (field.nodeIds) result.nodeIds = Int32Array.from(field.nodeIds);
        if (field.spectrum) result.spectrum = {
          frequencies: Float64Array.from(field.spectrum.frequencies),
          imaginaryValues: Float64Array.from(field.spectrum.imaginaryValues),
        };
        return result;
      };
      window.meshRoot = createRoot(document.getElementById('fixture'));
      window.renderMesh = (field, key = field.label + ':' + field.identity, displacementFields = []) => window.meshRoot.render(React.createElement(React.StrictMode, null, React.createElement(MeshFieldResult, {field: normalize(field), key, displacementFields: displacementFields.map(normalize)})));
      const picker = document.getElementById('fixture-mode');
      const replace = document.getElementById('replace-pressure');
      let recordedVisualizations;
      let recordedOutputs;
      const rigidMotion = {
        label:'Rigid motion',identity:'rigid-browser-fixture',bodyIds:['asymmetric-body'],lengthUnit:'m',
        times:new Float64Array([0,1]),
        vertices:new Float64Array([10,0,0,11,0,0,10,2,0,10,0,3]),
        triangles:new Uint32Array([0,2,1,0,1,3,0,3,2,1,2,3]),
        vertexOffsets:new Uint32Array([0,4]),triangleOffsets:new Uint32Array([0,4]),
        localCenters:new Float64Array([10,0,0]),positions:new Float64Array([0,0,0,2,0,0]),
        orientations:new Float64Array([1,0,0,0,0,0,0,1]),
      };
      picker.addEventListener('change', () => {
        replace.disabled = picker.value !== 'pressure';
        if (picker.value === 'rigid') {
          const noop = () => {};
          window.meshRoot.render(React.createElement(MeshTransformResult, {motion:rigidMotion,
            renderViewer:data=>React.createElement(JscadViewer,{layers:[],lengthUnit:'m',meshRenderData:data,
              meshIdentity:rigidMotion.identity,preserveCameraOnUpdate:true,onRenderStart:noop,onRenderEnd:noop,
              onRenderError:message=>{throw new Error(message)}})}));
        } else if (fixtures[picker.value]) {
          window.renderMesh(fixtures[picker.value], 'fixture-' + picker.value, picker.value === 'stress' ? [fixtures.displacement] : []);
        } else {
          const noop = () => {};
          window.meshRoot.render(React.createElement(WorkbenchViewer, {
            experiment: null,
            experimentDocument: {
              scene: null, handleRenderStart: noop, handleRenderEnd: noop,
              handleRenderError: (message) => { throw new Error(message); },
            },
            visualizations: recordedVisualizations,
            recordedRules: recordedOutputs?.rules, recordedData: recordedOutputs?.data,
            resultContracts: recordedOutputs?.contracts,
            selectedResult: picker.value.slice('record:'.length),
            onSelectedResultChange: (name) => { picker.value = 'record:' + name; picker.dispatchEvent(new Event('change')); },
            onFindSelectionSource: noop, onSelectionQueryChange: noop, onSelectionSourcePathsChange: noop,
            selectionQuery: null, selectionSourceStatus: {}, viewerExpanded: false,
          }));
        }
      });
      replace.addEventListener('click', () => window.renderMesh({ ...fixtures.pressure,
        values: Array(8).fill(1), spectrum: {frequencies: [61], imaginaryValues: Array(8).fill(0)},
      }, 'fixture-pressure'));
      window.renderMesh(window.meshField ?? fixtures.static);
      if (${Boolean(resultLocation)}) {
        const response = await fetch('/mesh-fixture-result');
        if (!response.ok) throw new Error('Saved fixture could not be loaded.');
        const saved = await response.json();
        for (const attachment of saved.attachments) {
          const response = await fetch('/mesh-fixture-attachment?id=' + encodeURIComponent(attachment.id));
          if (!response.ok) throw new Error('Saved attachment could not be loaded: ' + attachment.id);
          registerDataTensorAttachment(attachment.id, await response.arrayBuffer());
        }
        recordedVisualizations = saved.visualizations;
        recordedOutputs = saved.outputs;
        const visual = visualizationData(recordedVisualizations);
        if (Object.keys(visual.errors).length) throw new Error(JSON.stringify(visual.errors));
        const parsed = parseRecordedMeshFields(visual.rules, visual.data, visual.contracts);
        const transforms = parseRecordedMeshTransforms(visual.rules, visual.data, visual.contracts);
        const particles = parseRecordedParticleSets(visual.rules, visual.data, visual.contracts);
        if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors));
        if (transforms.errors.length) throw new Error(JSON.stringify(transforms.errors));
        if (particles.errors.length) throw new Error(JSON.stringify(particles.errors));
        if (!parsed.fields.length && !transforms.motions.length && !particles.particles.length)
          throw new Error('The saved result has no native geometry.');
        window.recordedMeshFields = parsed.fields;
        window.recordedMeshMotions = transforms.motions;
        window.recordedParticleSets = particles.particles;
        for (const field of [...parsed.fields, ...transforms.motions, ...particles.particles, ...Object.keys(saved.outputs.contracts).map(label=>({label}))]) {
          const option = document.createElement('option');
          option.value = 'record:' + field.label;
          option.textContent = 'Recorded ' + field.label.replace('@visualizations.', '');
          picker.append(option);
        }
        document.getElementById('saved-result-status').textContent = 'Saved result: ' + saved.jobId;
        if (${serverOnly}) {
          picker.value = [...parsed.fields, ...transforms.motions, ...particles.particles][0].label;
          picker.dispatchEvent(new Event('change'));
        }
      }
    `
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const requestPath = request.url?.split('?')[0]
          if (requestPath === '/mesh-fixture-result' && savedResult) {
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.end(JSON.stringify(savedResult))
            return
          }
          if (requestPath === '/mesh-fixture-attachment' && savedResult) {
            const id = new URL(request.url, 'http://127.0.0.1').searchParams.get('id')
            const bytes = savedAttachments.get(id)
            response.statusCode = bytes ? 200 : 404
            response.setHeader('Content-Type', 'application/octet-stream')
            response.end(bytes)
            return
          }
          if (request.url?.split('?')[0] !== '/mesh-fixture') return next()
          try {
            const html = await server.transformIndexHtml(
              '/mesh-fixture',
              '<!doctype html><html><head><meta charset="utf-8"></head><body><nav style="padding:8px;background:#f1f5f9"><label>Fixture <select id="fixture-mode" aria-label="Mesh fixture"><option value="static">Static displacement</option><option value="transient">Transient displacement</option><option value="displacement">Harmonic displacement</option><option value="stress">Harmonic stress</option><option value="pressure">Harmonic pressure</option><option value="rigid">Rigid motion</option></select></label> <button id="replace-pressure" disabled>Replace pressure sweep with 61 Hz</button> <span id="saved-result-status"></span></nav><div id="fixture" style="height:calc(100vh - 52px)"></div><script type="module" src="/mesh-fixture.tsx"></script></body></html>',
            )
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(html)
          } catch (error) {
            next(error)
          }
        })
      },
    },
  ],
})
let browser
try {
  if (resultLocation) {
    const directory = path.resolve(resultLocation)
    // Reuse the production provenance checks, then serve the unchanged attachment
    // bytes to the production browser decoder instead of inventing a fixture codec.
    const { inspectLocalResult } = await server.ssrLoadModule('/src/platform/node/localResult.ts')
    const { containedPath } = await server.ssrLoadModule('/src/platform/node/artifact.ts')
    const { manifest, resultContracts } = await inspectLocalResult(directory)
    assert.equal(manifest.state, 'succeeded')
    savedResult = {
      jobId: manifest.jobId,
      visualizations: {},
      outputs: { rules: [], data: {}, contracts: resultContracts },
      attachments: [],
    }
    for (const record of manifest.records) {
      const stored = JSON.parse(await readFile(await containedPath(directory, record.path), 'utf8'))
      savedResult.outputs.rules.push({
        label: record.name,
        methodId: 'local.recorded-data',
        target: [],
        parameters: {},
        result: record.schema,
      })
      savedResult.outputs.data[record.name] = stored.value
    }
    for (const entry of [...manifest.records, ...(manifest.visualizations ?? [])]) {
      for (const attachment of entry.attachments) {
        const bytes = await readFile(await containedPath(directory, attachment.path))
        assert.equal(bytes.byteLength, attachment.byteLength)
        savedAttachments.set(attachment.id, bytes)
        savedResult.attachments.push({ id: attachment.id })
      }
    }
    for (const entry of manifest.visualizations ?? []) {
      const stored = JSON.parse(await readFile(await containedPath(directory, entry.path), 'utf8'))
      savedResult.visualizations[entry.task] = stored.visualizations
    }
  }
  await server.listen()
  const address = server.httpServer.address()
  if (serverOnly) {
    console.log(`Mesh Viewer fixture: http://127.0.0.1:${address.port}/mesh-fixture`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } else {
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.error(error.message)
    })
    await page.addInitScript((field) => {
      window.meshField = field
    }, field)
    await page.goto(`http://127.0.0.1:${address.port}/mesh-fixture`)
    await page.getByRole('article', { name: 'Displacement mesh field' }).waitFor()
    const canvas = page.locator('canvas')
    await canvas.waitFor()
    const initial = await canvas.screenshot()
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.getByLabel('Displacement section axis').selectOption('0')
    const section = await canvas.screenshot()
    assert.ok(!initial.equals(section), 'A section must change the rendered volume, not just the controls.')
    await page.getByLabel('Displacement field component').selectOption('material')
    assert.equal(await page.getByText('Steel', { exact: true }).count(), 1)
    await page.getByLabel(/변형 배율/u).selectOption('manual')
    await page.getByLabel('Displacement displacement scale').fill('2')
    const outputDirectory = path.resolve('node_modules/.tmp')
    await mkdir(outputDirectory, { recursive: true })
    await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer.png') })
    const fixturePicker = page.getByLabel('Mesh fixture')
    await fixturePicker.selectOption('transient')
    await page.getByRole('article', { name: 'Transient displacement mesh field' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '이전 프레임', exact: true }).isDisabled(), true)
    const transientInitial = await canvas.screenshot()
    await page.getByRole('button', { name: '다음 프레임', exact: true }).click()
    await page.getByText('0.20000 s · 2/3', { exact: true }).waitFor()
    assert.ok(!transientInitial.equals(await canvas.screenshot()), 'The accepted transient frame must change the mesh.')
    assert.equal(await page.getByLabel('Transient displacement frequency').count(), 0)

    await fixturePicker.selectOption('rigid')
    await page.getByRole('article', { name: 'Rigid motion mesh transform' }).waitFor()
    const rigidInitial = await canvas.screenshot()
    await page.getByLabel('Animation time').evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.getByText('0.50000 s · 1/2', { exact: true }).waitFor()
    assert.ok(
      !rigidInitial.equals(await canvas.screenshot()),
      'An interpolated rigid pose must change the rendered mesh.',
    )
    assert.equal(await page.getByText(/실제 크기 1×/).count(), 1)
    assert.equal(await page.getByLabel(/displacement scale/).count(), 0)
    await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-rigid-motion.png') })

    await fixturePicker.selectOption('displacement')
    await page.getByRole('article', { name: 'Harmonic displacement mesh field' }).waitFor()
    assert.equal(await page.getByLabel('Harmonic displacement frequency').inputValue(), '40')
    assert.equal(await page.getByLabel('Harmonic displacement phase degrees').inputValue(), '0')
    await page.getByText('40 Hz · 0° · 순간값 Re(Q exp(iφ)) · peak phasor', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Transient playback').count(), 0)
    await page.getByLabel(/변형 배율/u).selectOption('actual')
    const displacementPhaseZero = await canvas.screenshot()
    await page.getByLabel('Harmonic displacement phase degrees').fill('90')
    assert.ok(!displacementPhaseZero.equals(await canvas.screenshot()), 'Harmonic phase must change the actual mesh.')
    await page.getByLabel('Harmonic displacement frequency').selectOption('90')
    await page.getByText('90 Hz · 90° · 순간값 Re(Q exp(iφ)) · peak phasor', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-harmonic-displacement.png') })

    await fixturePicker.selectOption('stress')
    await page.getByRole('article', { name: 'Harmonic stress mesh field' }).waitFor()
    assert.equal(await page.getByLabel('Harmonic stress frequency').inputValue(), '90')
    assert.equal(await page.getByLabel('Deformation result').inputValue(), 'Harmonic displacement')
    await page.getByLabel(/변형 배율/u).selectOption('actual')
    const stressPhaseZero = await canvas.screenshot()
    await page.getByLabel('Harmonic stress phase degrees').fill('90')
    assert.ok(
      !stressPhaseZero.equals(await canvas.screenshot()),
      'Stress and its compatible deformation must change with their common phase.',
    )
    await page.getByLabel('Harmonic stress section axis').selectOption('0')
    assert.ok(
      (await page.getByLabel('Harmonic stress section position').locator('..').textContent()).includes('0.5000'),
    )
    await page.getByLabel('Harmonic stress frequency').selectOption('40')
    await page.getByText('40 Hz · 90° · 순간값 Re(Q exp(iφ)) · peak phasor', { exact: true }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-harmonic-stress.png') })

    await fixturePicker.selectOption('pressure')
    await page.getByRole('article', { name: 'Harmonic pressure mesh field' }).waitFor()
    assert.equal(await page.getByLabel(/변형 배율/u).count(), 0)
    assert.equal(await page.getByLabel('Deformation result').count(), 0)
    await page.getByText('-2.0000', { exact: true }).waitFor()
    const positivePressure = await canvas.screenshot()
    await page.getByLabel('Harmonic pressure phase degrees').fill('180')
    const negativePressure = await canvas.screenshot()
    const pressureColors = await page.evaluate(
      async (images) =>
        Promise.all(
          images.map(async (png) => {
            const image = new Image()
            image.src = `data:image/png;base64,${png}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')
            context.drawImage(image, 0, 0)
            const pixels = context.getImageData(0, 0, image.width, image.height).data
            let red = 0,
              blue = 0
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index] > 200 && pixels[index + 1] < 80 && pixels[index + 2] < 80) red++
              if (pixels[index + 2] > 200 && pixels[index + 1] < 80 && pixels[index] < 80) blue++
            }
            return { red, blue }
          }),
        ),
      [positivePressure.toString('base64'), negativePressure.toString('base64')],
    )
    assert.ok(
      pressureColors[0].red > 1000 && pressureColors[0].red > pressureColors[0].blue * 10,
      'Positive pressure must render at the red end of the signed range.',
    )
    assert.ok(
      pressureColors[1].blue > 1000 && pressureColors[1].blue > pressureColors[1].red * 10,
      'A 180° phase change must render negative pressure at the blue end, not its absolute value.',
    )
    await page.getByLabel('Harmonic pressure frequency').selectOption('90')
    await page.getByLabel('Harmonic pressure phase degrees').fill('90')
    await page.getByText('90 Hz · 90° · 순간값 Re(Q exp(iφ)) · peak phasor', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-harmonic-pressure.png') })
    await page.getByRole('button', { name: 'Replace pressure sweep with 61 Hz', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '선택한 주파수 90 Hz' }).waitFor()
    assert.equal(await page.getByLabel('Harmonic pressure frequency').inputValue(), '90')
    assert.equal(await canvas.count(), 0, 'An unavailable frequency must not silently display another sample.')
    await page.getByLabel('Harmonic pressure frequency').selectOption('61')
    await canvas.waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      'Chromium transient frames, harmonic Hz/phase controls, stress deformation, signed pressure pixels and unavailable frequencies passed.',
    )
    if (savedResult) {
      await page.getByText(`Saved result: ${savedResult.jobId}`, { exact: true }).waitFor()
      const fields = await page.evaluate(() =>
        window.recordedMeshFields.map(({ label, points, cells, spectrum, componentCount, valueKind }) => ({
          label,
          nodes: points.length / 3,
          cells: cells.length / 4,
          frequencies: Array.from(spectrum?.frequencies ?? []),
          componentCount,
          valueKind,
        })),
      )
      const motions = await page.evaluate(() =>
        window.recordedMeshMotions.map(({ label, bodyIds, times, vertices, triangles }) => ({
          label,
          bodyIds,
          times: Array.from(times),
          vertices: vertices.length / 3,
          triangles: triangles.length / 3,
        })),
      )
      const particles = await page.evaluate(() =>
        window.recordedParticleSets.map(
          ({ label, particleIds, materialIndices, materialNames, times, attributes, radius }) => ({
            label,
            ids: Array.from(particleIds),
            materials: Array.from(materialIndices, (index) => materialNames[index]),
            times: Array.from(times),
            attributes: Object.entries(attributes).map(([name, quantity]) => ({
              name,
              components: quantity.components,
              unit: quantity.unit,
              quantityKind: quantity.quantityKind,
              rowConfiguration: quantity.rowConfiguration,
              columnConfiguration: quantity.columnConfiguration,
            })),
            physicalRadius: Boolean(radius),
          }),
        ),
      )
      assert.ok(
        fields.length + motions.length + particles.length,
        'The production decoder must reopen saved native geometry.',
      )
      for (const selected of fields) {
        assert.ok(selected.nodes > 4 && selected.cells > 1)
        await fixturePicker.selectOption('record:' + selected.label)
        await page.getByRole('article', { name: `${selected.label} mesh field` }).waitFor()
        await canvas.waitFor()
        if (selected.frequencies.length) {
          assert.equal(
            await page.getByLabel(`${selected.label} frequency`).inputValue(),
            String(selected.frequencies[0]),
          )
          await page.getByLabel(`${selected.label} frequency`).selectOption(String(selected.frequencies.at(-1)))
          await page.getByLabel(`${selected.label} phase degrees`).fill('90')
        }
        if (selected.valueKind === 'stress') {
          const displacement = fields.find((field) => field.valueKind === 'displacement')
          assert.equal(await page.getByLabel('Deformation result').inputValue(), displacement?.label)
        }
        if (selected.componentCount === 1) assert.equal(await page.getByLabel(/변형 배율/u).count(), 0)
        await page.getByLabel(`${selected.label} section axis`).selectOption('2')
        await canvas.screenshot()
        assert.equal(await page.getByRole('alert').count(), 0)
        await page.screenshot({
          path: path.join(outputDirectory, `mesh-viewer-recorded-${selected.label.replace(/[^a-zA-Z0-9]/g, '-')}.png`),
        })
      }
      for (const selected of motions) {
        assert.ok(selected.bodyIds.length && selected.vertices > 4 && selected.triangles > 4)
        await fixturePicker.selectOption('record:' + selected.label)
        await page.getByRole('article', { name: `${selected.label} mesh transform` }).waitFor()
        await canvas.waitFor()
        const initial = await canvas.screenshot()
        if (selected.times.length > 1) {
          const middle = (selected.times[0] + selected.times.at(-1)) / 2
          await page.getByLabel('Animation time').evaluate((input, time) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(time))
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }, middle)
          assert.ok(
            !initial.equals(await canvas.screenshot()),
            'The saved rigid history must animate its reference mesh.',
          )
        }
        assert.equal(await page.getByRole('alert').count(), 0)
        await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-recorded-rigid.png') })
      }
      for (const selected of particles) {
        assert.ok(selected.ids.length && selected.times.length && selected.attributes.length)
        await fixturePicker.selectOption('record:' + selected.label)
        const article = page.getByRole('article', { name: `${selected.label} particles` })
        await article.waitFor()
        await canvas.waitFor()
        assert.equal(await page.getByLabel('Particle 점 크기').count(), selected.physicalRadius ? 0 : 1)
        await page.getByLabel('Particle ID', { exact: true }).selectOption(String(selected.ids.at(-1)))
        await article
          .getByText(`ID ${selected.ids.at(-1)} · Material ${selected.materials.at(-1)} · t = ${selected.times[0]} s`, {
            exact: true,
          })
          .waitFor()
        for (const attribute of selected.attributes) {
          await page.getByLabel('Particle 물리량', { exact: true }).selectOption(attribute.name)
          const frames =
            attribute.rowConfiguration && attribute.columnConfiguration
              ? ' · 행: 현재 Cartesian · 열: 기준 Cartesian'
              : ''
          await article.getByText(`${attribute.quantityKind} · ${attribute.unit}${frames}`, { exact: true }).waitFor()
          if (attribute.components.length) {
            const component = page.getByLabel('Particle 성분', { exact: true })
            assert.deepEqual(await component.locator('option').allTextContents(), [...attribute.components, 'Norm'])
            await component.selectOption(String(attribute.components.length - 1))
            await component.selectOption('magnitude')
          }
        }
        await page.getByLabel('Particle 물리량', { exact: true }).selectOption('material')
        const initial = await canvas.screenshot()
        const hasMotion = await page.evaluate((label) => {
          const item = window.recordedParticleSets.find((candidate) => candidate.label === label)
          const width = item.particleIds.length * 3
          const last = (item.times.length - 1) * width
          return item.positions
            .subarray(0, width)
            .some((value, index) => Math.abs(value - item.positions[last + index]) > 1e-6)
        }, selected.label)
        if (selected.times.length > 1) {
          await page.getByLabel('Animation time').evaluate((input, time) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(time))
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }, selected.times.at(-1))
          await article
            .getByText(
              `ID ${selected.ids.at(-1)} · Material ${selected.materials.at(-1)} · t = ${selected.times.at(-1)} s`,
              { exact: true },
            )
            .waitFor()
          if (hasMotion)
            assert.ok(
              !initial.equals(await canvas.screenshot()),
              'Saved particle positions must change the rendered frame.',
            )
        }
        assert.equal(await page.getByRole('alert').count(), 0)
        await page.screenshot({
          path: path.join(outputDirectory, `mesh-viewer-recorded-particles-${savedResult.jobId}.png`),
        })
      }
      await page.evaluate(() => {
        const original = CanvasRenderingContext2D.prototype.fillText
        window.renderedAxisLabels = []
        CanvasRenderingContext2D.prototype.fillText = function (...args) {
          window.renderedAxisLabels.push(String(args[0]))
          return original.apply(this, args)
        }
      })
      for (const [name, contract] of Object.entries(savedResult.outputs.contracts)) {
        if (contract.visualization.kind !== 'box-grid') continue
        const spatialUnit = savedResult.outputs.data[name].boxGrid.lengthUnit
        const schema = savedResult.outputs.rules.find((rule) => rule.label === name).result
        assert.deepEqual(
          schema.axes.slice(0, 3).map((axis) => axis.unit),
          [spatialUnit, spatialUnit, spatialUnit],
        )
        await page.evaluate(() => {
          window.renderedAxisLabels = []
        })
        await fixturePicker.selectOption('record:' + name)
        await page
          .getByRole('button', { name: '3D Point cloud', exact: true })
          .waitFor()
          .catch(async (error) => {
            console.error(`Failed to open recorded output ${name}:`, await page.locator('body').innerText())
            throw error
          })
        await page.getByRole('button', { name: 'Heatmap', exact: true }).click()
        const heatmap = page.locator('[data-result-visualization="heatmap"]')
        await heatmap.waitFor()
        await page.screenshot({ path: path.join(outputDirectory, `mesh-viewer-recorded-grid-${name}.png`) })
        const axisLabels = await page.evaluate(() => window.renderedAxisLabels)
        for (const index of [1, 2]) {
          const axis = await page.getByLabel(`표시 축 ${index}`, { exact: true }).inputValue()
          if (['x', 'y', 'z'].includes(axis))
            assert.ok(
              axisLabels.includes(`${axis} (${spatialUnit})`),
              `The ${axis} display axis must show ${spatialUnit}: ${JSON.stringify(axisLabels)}.`,
            )
        }
        assert.equal(await page.getByRole('alert').count(), 0)
      }
      assert.deepEqual(errors, [])
      console.log(
        `Production local-result decoding and WorkbenchViewer reopened ${fields.length} fields, ${motions.length} motions, ${particles.length} particle sets and ${Object.keys(savedResult.outputs.contracts).length} Outputs:`,
        { fields, motions, particles },
      )
    }
    await page.evaluate((field) => {
      const count = 18_000
      const large = {
        ...field,
        identity: 'large-mesh',
        points: [],
        cells: [],
        values: [],
        boundaryFaces: [],
        boundaryCells: [],
        cellRegions: [],
        supportNodes: [],
        loadPoints: [],
        loadVectors: [],
      }
      const tetrahedron = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
      for (let cell = 0; cell < count; cell += 1) {
        tetrahedron.forEach((point) => {
          large.points.push(
            point[0] + (cell % 60) * 2,
            point[1] + (Math.floor(cell / 60) % 50) * 2,
            point[2] + Math.floor(cell / 3000) * 2,
          )
          large.values.push(cell / count, 0, 0)
        })
        large.cells.push(cell * 4, cell * 4 + 1, cell * 4 + 2, cell * 4 + 3)
        for (const face of [
          [0, 2, 1],
          [0, 1, 3],
          [0, 3, 2],
          [1, 2, 3],
        ]) {
          large.boundaryFaces.push(...face.map((node) => cell * 4 + node))
          large.boundaryCells.push(cell)
        }
        large.cellRegions.push(cell % 2)
      }
      window.renderMesh(large)
    }, field)
    await page.getByText('72,000 nodes', { exact: false }).waitFor()
    await canvas.screenshot()
    assert.deepEqual(errors, [])
    assert.equal(await page.getByRole('alert').count(), 0)
    console.log('Chromium WebGL mesh field, section, material, displacement and 72k-node rendering passed.')
    // Optional: one saved execution tests reopening; two Boolean Vars executions
    // also test updates in the same React card, without replacing its WebGL canvas.
    const localResults = []
    for (const resultArgument of process.argv.slice(2, 4)) {
      const directory = path.resolve(resultArgument)
      const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
      assert.equal(manifest.kind, 'local-cae-result')
      assert.equal(manifest.state, 'succeeded')
      const input = JSON.parse(await readFile(path.resolve(directory, manifest.input), 'utf8'))
      const visualizations = {}
      for (const entry of manifest.visualizations ?? []) {
        const stored = JSON.parse(await readFile(path.join(directory, entry.path), 'utf8'))
        assert.equal(stored.task, entry.task)
        assert.equal(stored.sequence, entry.sequence)
        assert.deepEqual(stored.attachments, entry.attachments)
        const frozen = input.measurement.experiment.simulationProgram.visualizationContracts[entry.task]
        const attachments = new Map(
          await Promise.all(
            entry.attachments.map(async (attachment) => {
              const binary = await readFile(path.join(directory, attachment.path))
              assert.equal(binary.byteLength, attachment.byteLength)
              return [attachment.id, binary]
            }),
          ),
        )
        for (const [name, visual] of Object.entries(stored.visualizations)) {
          assert.deepEqual(visual.schema, frozen[name].schema)
          assert.deepEqual(visual.contract, {
            artifactType: frozen[name].artifactType,
            visualization: frozen[name].visualization,
          })
          const pending = [visual.data]
          while (pending.length) {
            const item = pending.pop()
            if (!item || typeof item !== 'object') continue
            if (item.storage?.kind === 'attachments') {
              const bytes = Buffer.concat(item.storage.ids.map((id) => attachments.get(id)))
              assert.equal(bytes.byteLength, item.storage.byteLength)
              item.storage = { kind: 'base64', data: bytes.toString('base64'), byteLength: bytes.byteLength }
            } else if (!item.storage) pending.push(...Object.values(item))
          }
        }
        visualizations[entry.task] = stored.visualizations
      }
      assert.ok(Object.keys(visualizations).length, 'A saved execution must contain automatic visualizations.')
      localResults.push({
        visualizations,
        variables: input.measurement.experiment.variables,
        sourceHash: manifest.sourceHash,
      })
      await page.reload()
      await page.getByRole('article', { name: 'Displacement mesh field' }).waitFor()
      const reopened = await page.evaluate(async (visualizations) => {
        const { visualizationData } = await import('/src/features/viewer/viewer/visualizationData.ts')
        const { parseRecordedMeshFields } = await import('/src/features/viewer/viewer/meshFields.ts')
        const visual = visualizationData(visualizations)
        if (Object.keys(visual.errors).length) throw new Error(JSON.stringify(visual.errors))
        const parsed = parseRecordedMeshFields(visual.rules, visual.data, visual.contracts)
        if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors))
        window.reopenedMeshFields = parsed.fields
        return parsed.fields.map(({ label, identity, points, cells, componentCount, quantity }) => ({
          label,
          identity,
          nodes: points.length / 3,
          cells: cells.length / 4,
          componentCount,
          quantity,
        }))
      }, visualizations)
      for (const componentCount of [3, 6]) {
        const selected = reopened.find(
          (item) =>
            item.componentCount === componentCount && (componentCount === 6 || /displacement/i.test(item.quantity)),
        )
        assert.ok(selected, `A saved ${componentCount}-component Field must be available.`)
        assert.ok(selected.nodes > 4 && selected.cells > 1 && selected.identity.length === 64)
        await page.evaluate(
          (label) => window.renderMesh(window.reopenedMeshFields.find((item) => item.label === label)),
          selected.label,
        )
        await page.getByRole('article', { name: `${selected.label} mesh field` }).waitFor()
        await page.getByLabel(`${selected.label} section axis`).selectOption('0')
        await canvas.screenshot()
        assert.equal(await page.getByRole('alert').count(), 0)
      }
      await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer-recorded.png') })
      assert.deepEqual(errors, [])
      console.log(`Reopened ${reopened.length} real saved mesh Fields, including displacement and stress, in Chromium.`)
    }
    if (localResults.length === 2) {
      assert.equal(
        localResults[0].sourceHash,
        localResults[1].sourceHash,
        'Only Vars may change between the two actual executions.',
      )
      const updates = await page.evaluate(async (results) => {
        const { visualizationData } = await import('/src/features/viewer/viewer/visualizationData.ts')
        const { parseRecordedMeshFields } = await import('/src/features/viewer/viewer/meshFields.ts')
        window.meshUpdateFields = results.map(({ visualizations }) => {
          const visual = visualizationData(visualizations)
          if (Object.keys(visual.errors).length) throw new Error(JSON.stringify(visual.errors))
          const parsed = parseRecordedMeshFields(visual.rules, visual.data, visual.contracts)
          if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors))
          const field = parsed.fields.find((item) => /displacement/i.test(item.quantity))
          if (!field) throw new Error('A saved displacement Field is required for update verification.')
          return field
        })
        return window.meshUpdateFields.map((field) => {
          const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
          field.points.forEach((value, index) => {
            bounds.min[index % 3] = Math.min(bounds.min[index % 3], value)
            bounds.max[index % 3] = Math.max(bounds.max[index % 3], value)
          })
          return {
            label: field.label,
            identity: field.identity,
            nodes: field.points.length / 3,
            cells: field.cells.length / 4,
            bounds,
          }
        })
      }, localResults)
      assert.notEqual(updates[0].identity, updates[1].identity)
      assert.notDeepEqual(updates[0].bounds, updates[1].bounds)
      const screenshots = []
      for (const [step, index] of [0, 1, 0, 1, 0].entries()) {
        const selected = updates[index],
          variables = localResults[index].variables
        assert.ok(['thickness', 'holeRadius', 'holePosition'].every((name) => typeof variables[name] === 'number'))
        assert.ok(Math.abs(selected.bounds.max[2] - selected.bounds.min[2] - variables.thickness) < 1e-10)
        await page.evaluate(({ index, key }) => window.renderMesh(window.meshUpdateFields[index], key), {
          index,
          key: step < 3 ? 'retained-record-card' : `fresh-record-card-${step}`,
        })
        await page.getByText(`${selected.nodes.toLocaleString()} nodes`, { exact: false }).waitFor()
        if (step === 0)
          await page.evaluate(() => {
            window.meshUpdateCanvas = document.querySelector('canvas')
          })
        if (step === 1 || step === 2)
          assert.equal(await page.evaluate(() => window.meshUpdateCanvas === document.querySelector('canvas')), true)
        await page.getByLabel(`${selected.label} field component`).selectOption('material')
        for (const label of ['Mesh 경계선', '구속 / 하중'])
          if (await page.getByLabel(label).isChecked()) await page.getByLabel(label).uncheck()
        await page.getByLabel(`${selected.label} section axis`).selectOption('2')
        await page.getByLabel(`${selected.label} section position`).press('End')
        await page.getByLabel(`${selected.label} section position`).press('ArrowLeft')
        const cut = selected.bounds.min[2] + (selected.bounds.max[2] - selected.bounds.min[2]) * 0.99
        assert.ok(
          (await page.getByLabel(`${selected.label} section position`).locator('..').textContent()).includes(
            cut.toPrecision(4),
          ),
        )
        await page.getByLabel(`${selected.label} section axis`).selectOption('-1')
        await page.getByRole('button', { name: 'Set z camera view', exact: true }).click()
        const pixels = await canvas.screenshot()
        screenshots.push(pixels)
        const hole = await page.evaluate(async (png) => {
          const image = new Image()
          image.src = `data:image/png;base64,${png}`
          await image.decode()
          const probe = document.createElement('canvas')
          probe.width = image.width
          probe.height = image.height
          const context = probe.getContext('2d')
          context.drawImage(image, 0, 0)
          const row = context.getImageData(0, Math.floor(image.height / 2), image.width, 1).data
          const spans = []
          let start = -1
          for (let x = 0; x <= image.width; x += 1) {
            const blue =
              x < image.width &&
              row[x * 4] < 140 &&
              row[x * 4 + 1] > 100 &&
              row[x * 4 + 1] < 210 &&
              row[x * 4 + 2] > 200
            if (blue && start < 0) start = x
            if (!blue && start >= 0) {
              if (x - start > 5) spans.push([start, x - 1])
              start = -1
            }
          }
          if (spans.length !== 2)
            throw new Error(`Expected two material spans around the real Boolean hole, found ${JSON.stringify(spans)}.`)
          const width = spans[1][1] - spans[0][0]
          return {
            center: ((spans[0][1] + spans[1][0]) / 2 - spans[0][0]) / width,
            radius: (spans[1][0] - spans[0][1]) / (2 * width),
          }
        }, pixels.toString('base64'))
        // The perspective view includes the inner back rim, hence the pixel-scale
        // allowance; the exact physical thickness above comes from the saved mesh.
        assert.ok(
          Math.abs(hole.center - variables.holePosition) < 0.015,
          `Rendered hole center ${hole.center} must follow Vars ${variables.holePosition}.`,
        )
        assert.ok(
          Math.abs(hole.radius - variables.holeRadius) < 0.015,
          `Rendered hole radius ${hole.radius} must follow Vars ${variables.holeRadius}.`,
        )
        await page.screenshot({ path: path.join(outputDirectory, `mesh-viewer-vars-${step}.png`) })
        assert.equal(await page.getByRole('alert').count(), 0)
      }
      assert.ok(!screenshots[0].equals(screenshots[1]), 'Different actual Vars must change the displayed mesh.')
      assert.ok(
        screenshots[1].equals(screenshots[3]),
        'Updating the retained canvas must match a fresh render with no old geometry or buffers visible.',
      )
      assert.ok(
        screenshots[0].equals(screenshots[2]),
        'Shrinking back to the original mesh in the same canvas must not retain the larger mesh geometry.',
      )
      assert.ok(
        screenshots[0].equals(screenshots[4]),
        'Reopening the original result must reproduce its original mesh pixels.',
      )
      assert.deepEqual(errors, [])
      console.log(
        'Two actual Boolean Vars results updated one retained React/WebGL card; hole pixels, section bounds and fresh-render equivalence passed.',
      )
    }
  }
} finally {
  await browser?.close()
  await server.close()
}
