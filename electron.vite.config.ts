import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'extension-worker': resolve('src/main/extension-worker.mjs') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs' } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
