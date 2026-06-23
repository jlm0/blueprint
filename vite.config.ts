import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/site',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1'
  },
  preview: {
    host: '127.0.0.1'
  }
});
