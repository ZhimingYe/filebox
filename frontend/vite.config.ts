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
            // react-syntax-highlighter pulls refractor + a full language
            // bundle (~600KB). Its own chunk so the rest of vendor doesn't
            // invalidate when it updates.
            if (
              id.includes('/react-syntax-highlighter/') ||
              id.includes('/refractor/') ||
              id.includes('/prismjs/') ||
              id.includes('/prism-') ||
              id.includes('/refractor-')
            ) {
              return 'highlighter-vendor';
            }
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
          }
        },
      },
    },
  },
})
