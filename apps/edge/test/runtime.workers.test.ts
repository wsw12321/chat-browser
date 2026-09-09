/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createWorker, type Env } from '../src/index';
import { GATEWAY_URL_HEADER, POLICY_VERSION, ResponseReconciler, SSEParser } from '@chat/contracts';

const env: Env = {
  PUBLIC_ORIGIN: 'https://chat.example.com',
  GATEWAY_ORIGIN: 'https://gateway.example.com',
  MODEL_CAPABILITIES: '[{"id":"mock-text","images":false}]',
};
const request = () =>
  new Request('https://chat.example.com/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      model: 'mock-text',
      messages: [{ role: 'user', content: [{ type: 'text', text: '真实 Worker 运行时测试' }] }],
    }),
  });

describe('Cloudflare Workers runtime', () => {
  it('runs the Module Worker route in workerd and returns no-store JSON', async () => {
    const response = await SELF.fetch('https://chat.example.com/api/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('validates and forwards a custom Gateway response with native Workers streams', async () => {
    const calls: string[] = [];
    const worker = createWorker({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/v1/models')) return new Response('{"data":[{"id":"mock-text"}]}');
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_runtime","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"运行时回复"}]}]}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    const custom = request();
    custom.headers.set(GATEWAY_URL_HEADER, 'https://custom.example.com/proxy/v1/');
    const response = await worker.fetch(custom, env);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parser = new SSEParser(),
      reconciler = new ResponseReconciler();
    for (const event of parser.push(bytes)) reconciler.consume(event);
    expect(reconciler.finish()).toMatchObject({ state: 'completed', text: '运行时回复' });
    expect(calls).toEqual([
      'https://custom.example.com/proxy/v1/models',
      'https://custom.example.com/proxy/v1/responses',
    ]);
    await vi.waitFor(() => expect(worker.counts()).toEqual({ active: 0, parsing: 0 }));
  });
  it('cancels native Workers upstream stream and releases the held entry permit', async () => {
    let cancelled = false,
      aborted = false;
    const worker = createWorker({
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/models'))
          return new Response('{"data":[{"id":"mock-text"}]}');
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    const response = await worker.fetch(request(), env);
    expect(worker.counts().active).toBe(1);
    await response.body!.cancel();
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
  });
});
