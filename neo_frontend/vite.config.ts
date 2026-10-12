import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Mounted by the hub at /neo (and /neo/popout.html for dockview popouts).
// Keep base in sync with crates/hub ServeDir nest path and release staging.
export default defineConfig({
  base: '/neo/',
  plugins: [react()],
  server: {
    port: 5174,
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
