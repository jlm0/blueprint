import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [...builtinModules, ...builtinModules.map(moduleName => `node:${moduleName}`)];

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist/cli',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      preserveEntrySignatures: 'exports-only',
      external: nodeBuiltins,
      input: {
        cli: 'src/cli.ts',
        index: 'src/index.ts'
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
});
