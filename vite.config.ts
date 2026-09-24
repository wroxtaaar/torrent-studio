import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      hmr: {
        host: '129.154.242.170',
        protocol: 'ws',
        port: 3000,
      },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
      watch: {
        usePolling: true,
        interval: 500,
      },
    },
  };
});
