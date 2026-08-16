import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// The PixGPT API server; only it is allowed to talk to OmniRoute.
const API_SERVER = process.env.PIXGPT_SERVER_URL ?? 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In development the SPA and the API are on different ports. Proxying
      // keeps them same-origin for the browser, so no CORS is needed and the
      // gateway key still never leaves the server.
      '/api': {
        target: API_SERVER,
        changeOrigin: true,
        // Server-Sent Events must not be buffered by the proxy
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            }
          })
        },
      },
    },
  },
  build: {
    // NOTE: do not add `manualChunks` for katex / react-syntax-highlighter.
    // Forcing them into named chunks makes Rollup hoist those chunks into the
    // entry graph, so Vite emits <link rel="modulepreload"> (and an eager
    // stylesheet) for them — turning ~390 kB of deliberately lazy code into a
    // first-paint download. Vite's automatic splitting already keeps them
    // inside the dynamically-imported Markdown chunk, which is what we want.
    // The "chunk larger than 500 kB" warning refers to that lazy chunk and is
    // advisory; raising the limit here only documents the intent.
    chunkSizeWarningLimit: 600,
  },
})
