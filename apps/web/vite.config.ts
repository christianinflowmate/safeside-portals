import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The API is a separate process; everything under /api is proxied to it. */
const API_TARGET = 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: {
    port: 3000,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
});
