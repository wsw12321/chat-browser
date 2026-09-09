import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('./apps/web', import.meta.url));
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: 'offline-shell-manifest',
      async writeBundle(_options, bundle) {
        const version = Date.now().toString(36);
        const assets = Object.keys(bundle)
          .filter((name) => !name.endsWith('.map'))
          .map((name) => `/${name}`);
        await writeFile(
          new URL('./dist/shell-manifest.json', import.meta.url),
          JSON.stringify({ version, assets: ['/', '/favicon.svg', ...assets] }),
        );
        const serviceWorker = await readFile(
          new URL('./apps/web/public/sw.js', import.meta.url),
          'utf8',
        );
        await writeFile(
          new URL('./dist/sw.js', import.meta.url),
          serviceWorker.replaceAll('__BUILD_ID__', version),
        );
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: '../../dist', emptyOutDir: true, sourcemap: false },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'parsers/[name]-[hash].js',
        chunkFileNames: 'parsers/[name]-[hash].js',
        assetFileNames: 'parsers/[name]-[hash][extname]',
      },
    },
  },
});
