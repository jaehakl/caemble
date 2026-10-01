/** Production UI/isolated Calculation runner around the real WebRTC fixture. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createNetServer } from 'node:net';

const uiRoot = fileURLToPath(new URL('../../ui/', import.meta.url));
const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { chromium } = require('playwright');
process.chdir(uiRoot);
async function availablePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const [hostPort, runnerPort] = await Promise.all([availablePort(), availablePort()]);
const target = process.argv[2];
const fixtureSource = readFileSync(new URL('./prediction-ui-fixture.js', import.meta.url), 'utf8');
const app = await createServer({
  root: uiRoot,
  configFile: fileURLToPath(new URL('../../ui/vite.config.ts', import.meta.url)),
  logLevel: 'error',
  define: { 'import.meta.env.VITE_CAEMBLE_RUNNER_ORIGIN': JSON.stringify(`http://127.0.0.1:${runnerPort}`) },
  server: {
    host: '127.0.0.1', port: hostPort, strictPort: true, hmr: false,
    proxy: Object.fromEntries(['/v1', '/sdk', '/scenario.js', '/fixture'].map(path => [path, { target }])),
  },
  plugins: [{
    name: 'remote-prediction-acceptance',
    resolveId(id) { if (id === '/prediction-ui-fixture.js') return '\0prediction-ui-fixture'; },
    load(id) { if (id === '\0prediction-ui-fixture') return fixtureSource; },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(await server.transformIndexHtml('/', '<!doctype html><html><head><title>Remote Forward acceptance</title></head><body><div id="fixture" style="height:600px;width:900px"></div><script type="module">import("/prediction-ui-fixture.js").then(() => window.predictionFixtureReady = true)</script></body></html>'));
      });
    },
  }],
});
let runner, browser;
try {
  await app.listen();
  const port = app.httpServer.address().port;
  runner = await createServer({
    root: uiRoot,
    configFile: fileURLToPath(new URL('../../ui/vite.runner.config.ts', import.meta.url)),
    logLevel: 'error',
    define: { 'import.meta.env.VITE_CAEMBLE_HOST_ORIGIN': JSON.stringify(`http://127.0.0.1:${port}`) },
    server: { host: '127.0.0.1', port: runnerPort, strictPort: true },
  });
  await runner.listen();
  const executablePath = process.env.CAEMBLE_TEST_CHROMIUM ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => process.stderr.write(`${error.stack}\n`));
  page.on('console', event => { if (event.type() === 'error') process.stderr.write(`${event.text()}\n`); });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => window.predictionFixtureReady, undefined, { timeout: 60000 });
  const result = await page.evaluate(async () => (await import('/scenario.js')).default());
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser?.close();
  await runner?.close();
  await app.close();
}
