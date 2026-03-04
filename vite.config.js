import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  base: '/',
  build: {
    target: 'es2020',
    sourcemap: false,
    cssMinify: true,
  },
  preview: {
    host: true,
    port: 4173,
  },
})