import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5177,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4178',
        changeOrigin: true
      }
    }
  }
});
