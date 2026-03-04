import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
