import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const runnerHtmlPath = fileURLToPath(new URL('./runner.html', import.meta.url))
const runnerCsp =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"
const calculationWorkerCsp =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export default defineConfig({
  appType: 'custom',
  cacheDir: 'node_modules/.vite-runner',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    entries: ['runner.html'],
  },
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    hmr: false,
  },
  worker: {
    format: 'es',
  },
  plugins: [
    {
      name: 'caemble-runner-html',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
          if (pathname === '/src/lib/calculation/runner.worker.ts') {
            response.setHeader('Content-Security-Policy', calculationWorkerCsp)
            response.setHeader('Referrer-Policy', 'no-referrer')
            next()
            return
          }
          if (pathname !== '/' && pathname !== '/runner.html') {
            next()
            return
          }
          try {
            response.statusCode = 200
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('Content-Security-Policy', runnerCsp)
            response.setHeader('Referrer-Policy', 'no-referrer')
            response.end(await readFile(runnerHtmlPath, 'utf8'))
          } catch (error) {
            next(error as Error)
          }
        })
      },
    },
  ],
})
