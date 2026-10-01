import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(new URL('../../../../ui/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CAEMBLE_TEST_CHROMIUM ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage();
  page.on('console', (event) => { if (event.type() === 'error') process.stderr.write(`${event.text()}\n`); });
  await page.goto(process.argv[2]);
  const result = await page.evaluate(async () => (await import('/scenario.js')).default());
  process.stdout.write(JSON.stringify(result));
} finally {
  await browser.close();
}
