import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const uiRoot = fileURLToPath(new URL('.', import.meta.url))
const sdkRoot = fileURLToPath(new URL('../sdk/master/js', import.meta.url))
const slavesRoot = fileURLToPath(new URL('../slaves', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  cacheDir: 'node_modules/.vite-app',
  define: mode === 'test' ? {} : { 'process.env.BABEL_TYPES_8_BREAKING': 'false' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [
        uiRoot,
        sdkRoot,
        slavesRoot,
        fileURLToPath(new URL('../../docs/authoring', import.meta.url)),
        fileURLToPath(new URL('../../docs/manual', import.meta.url)),
      ],
    },
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    commonjsOptions: {
      strictRequires: ['**/node_modules/@babel/**'],
    },
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.code === 'PLUGIN_WARNING' &&
          warning.plugin === 'vite:resolve' &&
          warning.message.includes('node:module') &&
          warning.message.includes('manifold-3d/manifold.js')
        ) {
          return
        }
        if (warning.code === 'INVALID_ANNOTATION' && /[/\\]node_modules[/\\]zod[/\\]/.test(warning.id ?? '')) {
          return
        }
        warn(warning)
      },
      input: {
        main: 'index.html',
        runner: 'runner.html',
        render: 'render.html',
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'caemble-browser-boundary',
      generateBundle() {
        const forbidden = [...this.getModuleIds()].filter((id) =>
          /\/src\/(cli|platform\/node)\//.test(id.replace(/\\/g, '/')),
        )
        if (forbidden.length) throw new Error(`Browser bundle imports Node execution: ${forbidden.join(', ')}`)
        const privateDocs = [...this.getModuleIds()].filter((id) =>
          /\/(docs\/(development|operations|archive)\/|src\/documentation\/(development|index)\.ts)/.test(
            id.replace(/\\/g, '/'),
          ),
        )
        if (privateDocs.length)
          throw new Error(`Browser bundle imports repository-only documentation: ${privateDocs.join(', ')}`)
      },
    },
  ],
  worker: {
    format: 'es',
  },
}))
