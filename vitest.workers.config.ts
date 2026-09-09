import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './apps/edge/src/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          PUBLIC_ORIGIN: 'https://chat.example.com',
          GATEWAY_ORIGIN: 'https://gateway.example.com',
          MODEL_CAPABILITIES: '[{"id":"mock-text","images":false}]',
        },
      },
    }),
  ],
  test: { include: ['apps/edge/test/*.workers.test.ts'], testTimeout: 15000 },
});
