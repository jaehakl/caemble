import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  plugins: [
    {
      name: 'viewer-display-fixture',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== '/viewer-display-fixture') return next()
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            await vite.transformIndexHtml(
              '/viewer-display-fixture',
              '<html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module" src="/scripts/viewer-display-fixture.tsx"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
await server.listen()
console.log('http://127.0.0.1:5187/viewer-display-fixture')
