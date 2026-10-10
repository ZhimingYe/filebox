import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served by Hub under /neo (see crates/hub/src/routes.rs).
// Keep base in sync with that nest path so asset URLs resolve.
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
  },
})
