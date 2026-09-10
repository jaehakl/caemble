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
  lengthUnit: 'm',
  valueUnit: 'm',
  quantity: 'kinematics.Displacement',
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
const server = await createServer({
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
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
      import '/src/index.css';
      window.meshRoot = createRoot(document.getElementById('fixture'));
      window.renderMesh = (field, key = field.label + ':' + field.identity) => window.meshRoot.render(React.createElement(React.StrictMode, null, React.createElement(MeshFieldResult, {field, key})));
      window.renderMesh(window.meshField);
    `
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/mesh-fixture') return next()
          try {
            const html = await server.transformIndexHtml(
              '/mesh-fixture',
              '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module" src="/mesh-fixture.tsx"></script></body></html>',
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
  await server.listen()
  const address = server.httpServer.address()
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
  await page.getByLabel('Displacement displacement scale').fill('2')
  const outputDirectory = path.resolve('node_modules/.tmp')
  await mkdir(outputDirectory, { recursive: true })
  await page.screenshot({ path: path.join(outputDirectory, 'mesh-viewer.png') })
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
    const schemas = {},
      records = {}
    for (const record of manifest.records) {
      const stored = JSON.parse(await readFile(path.join(directory, record.path), 'utf8'))
      assert.deepEqual(stored.schema, record.schema)
      assert.equal(stored.name, record.name)
      schemas[record.name] = record.schema
      records[record.name] = stored.value
      const attachments = new Map(
        await Promise.all(
          record.attachments.map(async (attachment) => {
            const bytes = await readFile(path.join(directory, attachment.path))
            assert.equal(bytes.byteLength, attachment.byteLength)
            return [attachment.id, bytes]
          }),
        ),
      )
      const pending = [stored.value]
      while (pending.length) {
        const item = pending.pop()
        if (item.storage?.kind === 'attachments') {
          const bytes = Buffer.concat(item.storage.ids.map((id) => attachments.get(id)))
          assert.equal(bytes.byteLength, item.storage.byteLength)
          item.storage = { kind: 'base64', data: bytes.toString('base64'), byteLength: bytes.byteLength }
        } else if (!item.storage) pending.push(...Object.values(item))
      }
    }
    localResults.push({
      schemas,
      records,
      variables: input.measurement.experiment.variables,
      sourceHash: manifest.sourceHash,
    })
    await page.reload()
    await page.getByRole('article', { name: 'Displacement mesh field' }).waitFor()
    const reopened = await page.evaluate(
      async ({ schemas, records }) => {
        const { recordedDataRules, flattenRecordedData } = await import('/src/lib/cad/simulation/recordedData.ts')
        const { parseRecordedMeshFields } = await import('/src/features/viewer/viewer/meshFields.ts')
        const parsed = parseRecordedMeshFields(
          recordedDataRules(schemas, 'local.recorded-data'),
          flattenRecordedData(schemas, records),
        )
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
      },
      { schemas, records },
    )
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
      const { recordedDataRules, flattenRecordedData } = await import('/src/lib/cad/simulation/recordedData.ts')
      const { parseRecordedMeshFields } = await import('/src/features/viewer/viewer/meshFields.ts')
      window.meshUpdateFields = results.map(({ schemas, records }) => {
        const parsed = parseRecordedMeshFields(
          recordedDataRules(schemas, 'local.recorded-data'),
          flattenRecordedData(schemas, records),
        )
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
      for (const label of ['Mesh edges', 'Supports / loads'])
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
            x < image.width && row[x * 4] < 140 && row[x * 4 + 1] > 100 && row[x * 4 + 1] < 210 && row[x * 4 + 2] > 200
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
} finally {
  await browser?.close()
  await server.close()
}
