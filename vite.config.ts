import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: process.env.NODE_ENV === 'production' ? 'http://samhost.wcore.com.br:3001' : 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/content': {
        target: process.env.NODE_ENV === 'production' ? 'http://samhost.wcore.com.br:3001' : 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        timeout: 30000,
        followRedirects: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('Proxy error:', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Proxying request:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('Proxy response:', proxyRes.statusCode, req.url);
          });
        },
      },
      '/vod': {
        target: process.env.NODE_ENV === 'production' ? 'http://samhost.wcore.com.br' : 'http://localhost',
        changeOrigin: true,
        secure: false,
        timeout: 30000,
        followRedirects: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
          ui: ['@mui/material', '@mui/icons-material'],
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});