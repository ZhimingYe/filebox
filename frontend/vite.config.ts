import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
    rollupOptions: {
      output: {
        // Vendor chunk splitting: groups large third-party deps into
        // separately cacheable chunks. Total bytes are unchanged but
        // deployments that don't touch a vendor's version let the browser
        // reuse the cached chunk instead of re-downloading.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router-dom/') ||
              id.includes('/react-router/')
            ) {
              return 'react-vendor';
            }
            // NOTE: do NOT force monaco-editor into a manual chunk. Putting it in
            // `monaco-vendor` caused Vite's shared module-preload helper to land
            // in that same chunk, so the main index eagerly imported the whole
            // ~4MB Monaco bundle on every page load. TextPreview is already
            // React.lazy()'d — Monaco stays behind that dynamic import.
            // react-markdown + remark + micromark pipeline.
            if (
              id.includes('/react-markdown/') ||
              id.includes('/remark-') ||
              id.includes('/micromark-') ||
              id.includes('/mdast-') ||
              id.includes('/hast-') ||
              id.includes('/unist-') ||
              id.includes('/vfile-') ||
              id.includes('/trough/') ||
              id.includes('/bail/') ||
              id.includes('/character-') ||
              id.includes('/decode-named-character-reference/')
            ) {
              return 'markdown-vendor';
            }
            // UTIF (TIFF decoder) + pako (deflate for some TIFFs). Only
            // loaded when a .tif/.tiff is opened.
            if (id.includes('/utif/') || id.includes('/pako/')) {
              return 'tiff-vendor';
            }
          }
        },
      },
    },
  },
})
