import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.BACKEND_PORT || 3001}`,
        changeOrigin: true,
        secure: false,
      }
    }
  },
  plugins: [react()],
  // NOTE: API keys are NOT injected into the frontend bundle.
  // The frontend fetches the key at runtime from /api/config (auth-protected).
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});
