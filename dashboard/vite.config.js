import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://master:5000',
        changeOrigin: true,
      },
      '/worker-1': {
        target: 'http://worker-1:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker-1/, ''),
      },
      '/worker-2': {
        target: 'http://worker-2:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker-2/, ''),
      },
      '/worker-3': {
        target: 'http://worker-3:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker-3/, ''),
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 8080,
  },
})

