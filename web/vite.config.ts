import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'


export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // Enable stream polyfills for sol-apy-sdk
      include: ['stream', 'buffer', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  base: '/stake-blend',
  define: {
    global: 'globalThis',
  },
})