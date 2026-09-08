import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../docs/authoring', import.meta.url)),
        fileURLToPath(new URL('../../docs/manual', import.meta.url)),
        fileURLToPath(new URL('../sdk/master/js', import.meta.url)),
      ],
    },
  },
  test: {
    clearMocks: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
