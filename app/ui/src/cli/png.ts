import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { containedPath, openArtifact } from '@/platform/node/artifact'
import { CliError, executionEnvironment } from '@/platform/node/environment'
import { normalizeCalculationRunnerOutput } from '@/lib/calculation/validation'
import { inspectLocalResult } from '@/platform/node/localResult'
import type { CommandContext } from './types'

export async function pngCommand(command: string, context: CommandContext) {
  const { args, options, environment, signal } = context
  if (!options.out) throw new CliError('png requires --out <image.png>.')
  const width = Number(options.width ?? 1200),
    height = Number(options.height ?? 800)
  if (![width, height].every((value) => Number.isInteger(value) && value >= 200 && value <= 8192))
    throw new CliError('PNG dimensions must be 200–8192 pixels.')
  let payload: unknown, provenance: unknown
  if (command === 'geometry') {
    if (options.measurement) {
      const input = await context
        .client()
        .request('get', `/cae/measurements/${Number(options.measurement)}/artifact`, undefined, {
          signal,
          resolveObjects: true,
        })
      payload = { kind: 'geometry', input, task: options.task }
      const metadata = await context
        .client()
        .request<object>('get', `/cae/measurements/${Number(options.measurement)}/artifact-info`, undefined, { signal })
      provenance = { kind: 'remote-measurement', ...metadata }
    } else if (options.result) {
      const result = await inspectLocalResult(String(options.result))
      const bytes = await readFile(result.manifest.input)
      if (createHash('sha256').update(bytes).digest('hex') !== result.manifest.inputHash)
        throw new CliError('Local result input changed during PNG preparation.', 4)
      payload = { kind: 'geometry', input: JSON.parse(bytes.toString('utf8')), task: options.task }
      provenance = {
        kind: 'local-cae-result',
        path: path.resolve(String(options.result)),
        input_hash: result.manifest.inputHash,
        source_hash: result.manifest.sourceHash,
        catalog_revision: result.manifest.catalogRevision,
        state: result.manifest.state,
      }
    } else {
      if (!args[0]) throw new CliError('png geometry requires an artifact or --measurement.')
      const stored = await openArtifact(args[0])
      const item = stored.artifact.items.find((value) => value.index === Number(options.item ?? 1))
      if (!item) throw new CliError('Artifact item was not found.')
      payload = { kind: 'geometry', input: JSON.parse((await stored.readItem(item)).toString()), task: options.task }
      provenance = {
        kind: 'artifact',
        artifact: stored.directory,
        source_hash: stored.artifact.source_hash,
        input_hash: item.input_hash,
        catalog_revision: stored.artifact.catalog_revision,
        item: item.index,
      }
    }
  } else if (command === 'calculation') {
    const bytes = await readFile(args[0])
    const result = JSON.parse(bytes.toString('utf8'))
    const output = normalizeCalculationRunnerOutput(result.output ?? result.data ?? result)
    payload = { kind: 'calculation', output }
    provenance = {
      kind: 'calculation-result',
      path: path.resolve(args[0]),
      result_hash: createHash('sha256').update(bytes).digest('hex'),
      input_hash: result.input_hash ?? null,
      source_hash: result.source_hash ?? null,
      source: result.provenance,
    }
  } else throw new CliError('Use png geometry or png calculation.')
  const assets = path.join(environment.repo, 'app/ui/dist')
  const browser = await chromium.launch({
    headless: true,
    executablePath: options['chromium-path'] as string | undefined,
    env: executionEnvironment(),
  })
  const abort = () => {
    void browser.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== 'http://caemble-render.invalid') {
        await route.abort()
        return
      }
      const file = url.pathname === '/' ? 'render.html' : decodeURIComponent(url.pathname.slice(1))
      try {
        const content = await readFile(await containedPath(assets, file))
        const contentType = file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : file.endsWith('.wasm')
                ? 'application/wasm'
                : file.endsWith('.svg')
                  ? 'image/svg+xml'
                  : 'application/octet-stream'
        await route.fulfill({ status: 200, contentType, body: content })
      } catch {
        await route.fulfill({ status: 404, body: 'Asset not found. Run npm run build-ui.' })
      }
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://caemble-render.invalid/render.html')
    await page.waitForFunction(() => typeof window.caembleRender === 'function')
    await page.evaluate((value) => window.caembleRender(value as Parameters<Window['caembleRender']>[0]), payload)
    await page.waitForFunction(() => window.caembleRenderState.ready || window.caembleRenderState.error, undefined, {
      timeout: Number(options.timeout ?? 60) * 1000,
    })
    const state = await page.evaluate(() => window.caembleRenderState)
    if (state.error || errors.length) throw new CliError(state.error ?? errors.join('\n'), 1)
    const camera = String(options.camera ?? 'iso')
    if (command === 'geometry') {
      if (!['iso', 'x', 'y', 'z'].includes(camera)) throw new CliError('Camera must be iso, x, y, or z.')
      await page
        .getByRole('button', { name: `Set ${camera === 'iso' ? 'default' : camera} camera view`, exact: true })
        .click()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
    }
    signal.throwIfAborted()
    const destination = path.resolve(String(options.out))
    await page.screenshot({ path: destination, type: 'png' })
    const metadata = {
      provenance,
      renderer: {
        chromium: browser.version(),
        frontend: 'Caemble shared viewer/chart',
        frontend_hash: createHash('sha256')
          .update(await readFile(path.join(assets, 'render.html')))
          .digest('hex'),
        viewport: { width, height },
        camera: command === 'geometry' ? camera : null,
        task: options.task ?? null,
      },
    }
    await writeFile(`${destination}.json`, JSON.stringify(metadata, null, 2), 'utf8')
    return { path: destination, metadata: `${destination}.json`, ...metadata }
  } catch (error) {
    if (signal.aborted) throw new CliError('PNG export interrupted.', 130)
    if (error instanceof Error && error.name === 'TimeoutError') throw new CliError(error.message, 5)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    await browser.close()
  }
}
