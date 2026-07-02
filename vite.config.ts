import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    // The media worker and the wasm-pack (`--target web`) glue are ES modules.
    format: 'es',
  },
  build: {
    // WASM binaries can exceed the default 500 kB inline-warning threshold.
    chunkSizeWarningLimit: 4096,
  },
})
