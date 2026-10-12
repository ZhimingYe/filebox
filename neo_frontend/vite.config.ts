import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const classicSrc = path.resolve(__dirname, '../frontend/src')
const neoReact = path.resolve(__dirname, 'node_modules/react')
const neoReactDom = path.resolve(__dirname, 'node_modules/react-dom')

// Mounted by the hub at /neo (and /neo/popout.html for dockview popouts).
// Keep base in sync with crates/hub ServeDir nest path and release staging.
export default defineConfig({
  base: '/neo/',
  plugins: [react()],
  resolve: {
    // Import classic modules as `@classic/...` without a shared package yet.
    // Deduplicate React so classic sources and neo share one copy (hooks break
    // otherwise when Vite resolves two react trees).
    alias: {
      '@classic': classicSrc,
      react: neoReact,
      'react-dom': neoReactDom,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5174,
    // Allow Vite to read classic sources outside neo_frontend/.
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // Classic viewers pulled through @classic — pre-bundle heavy deps.
    include: [
      'pdfjs-dist',
      'react-pdf',
      'monaco-editor',
      '@monaco-editor/react',
      'react-markdown',
      'remark-gfm',
      'react-window',
      'utif',
      'pako',
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
