import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

const here = import.meta.dirname
// Workspace packages ship TypeScript source, so they must be bundled rather
// than externalised -- Node cannot import a .ts file at runtime.
const bundleWorkspace = { exclude: ['@cocine/client', '@cocine/player', '@cocine/protocol', '@cocine/sync'] }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    // Baked in so a release points at the instance its users should join. A
    // development build leaves it empty and falls back to localhost.
    define: {
      __COCINE_DEFAULT_SERVER__: JSON.stringify(process.env.COCINE_DEFAULT_SERVER ?? '')
    },
    build: { rollupOptions: { input: resolve(here, 'src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: {
      rollupOptions: {
        input: resolve(here, 'src/preload/index.ts'),
        // Electron loads preload scripts as CommonJS; emitting ESM here fails
        // at load time with no useful error.
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    // libass ships its own worker and constructs it with `new Worker(new
    // URL(...), { type: 'module' })`. Vite bundles that worker itself, and its
    // default IIFE output cannot code-split, which fails the whole build with
    // an error naming rollup rather than the dependency.
    worker: { format: 'es' },
    // With `root` pointed at src/renderer, outDir resolves relative to it and
    // the build escapes the package. Pin it.
    build: {
      outDir: resolve(here, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(here, 'src/renderer/index.html') }
    },
    esbuild: { jsx: 'automatic' }
  }
})
