import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map(moduleName => `node:${moduleName}`)]);
const runtimePackages = new Set(['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio', 'zod/v4']);

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/mcp',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      preserveEntrySignatures: 'exports-only',
      external: id => nodeBuiltins.has(id) || runtimePackages.has(id),
      input: {
        server: 'src/mcp/server.ts',
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
