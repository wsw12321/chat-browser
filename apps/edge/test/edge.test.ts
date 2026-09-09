import { describe, expect, it, vi } from 'vitest';
import {
  POLICY,
  GATEWAY_URL_HEADER,
  POLICY_VERSION,
  ResponseReconciler,
  SSEParser,
  crc32,
  encodeSSE,
  utf8Bytes,
  type ChatRequest,
} from '@chat/contracts';
import { createWorker, type Env } from '../src/index';

const env: Env = {
  PUBLIC_ORIGIN: 'https://chat.example.com',
  GATEWAY_ORIGIN: 'https://gateway.example.com',
  MODEL_CAPABILITIES: JSON.stringify([
    { id: 'mock-text', images: false },
    { id: 'mock-vision', images: true },
  ]),
  FEATURE_IMAGES: 'true',
  FEATURE_PDF: 'true',
  FEATURE_DOCX: 'true',
};
const payload = () => ({
  schemaVersion: 1,
  policyVersion: POLICY_VERSION,
  clientRequestId: '00000000-0000-4000-8000-000000000001',
  model: 'mock-text',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
});
const request = (body: unknown = payload(), overrides: RequestInit = {}) =>
  new Request(`${env.PUBLIC_ORIGIN}/api/chat`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      Origin: env.PUBLIC_ORIGIN,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...overrides,
  });
const models = () =>
  new Response(
    JSON.stringify({
      data: [
        { id: 'mock-text' },
        { id: 'mock-vision' },
        { id: 'codex-auto-review' },
        { id: 'unreviewed' },
      ],
    }),
    { headers: { 'Content-Type': 'application/json', 'X-Gateway-Request-ID': 'gw_models' } },
  );
const sse = (type: string, fields: Record<string, unknown>) =>
  encodeSSE({ event: type, data: JSON.stringify({ type, ...fields }) });
const complete = () =>
  sse('response.completed', {
    response: {
      id: 'resp_1',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] },
      ],
    },
  });
function mockGateway(generate?: (input: Request) => Response | Promise<Response>) {
  let generations = 0;
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    if (new URL(req.url).pathname.endsWith('/v1/models')) return models();
    generations++;
    return generate
      ? generate(req)
      : new Response(complete(), {
          headers: { 'Content-Type': 'text/event-stream', 'X-Gateway-Request-ID': 'gw_generation' },
        });
  };
  return { fetcher, calls, generations: () => generations };
}
async function streamSnapshot(response: Response) {
  const parser = new SSEParser(),
    reconciler = new ResponseReconciler();
  for (const event of parser.push(new Uint8Array(await response.arrayBuffer())))
    reconciler.consume(event);
  for (const event of parser.finish()) reconciler.consume(event);
  return reconciler.finish();
}

describe('edge routing, authentication and limits', () => {
  it('returns public config and API JSON 404 without invoking upstream', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const config = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/config`), env);
    expect(await config.json()).toMatchObject({
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      gatewayUrl: env.GATEWAY_ORIGIN,
      features: { images: true },
    });
    const missing = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/upload`), env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toContain('application/json');
    expect(mock.calls).toHaveLength(0);
  });
  it('intersects gateway permissions with explicit model capabilities', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/api/models`, {
        headers: { Authorization: 'Bearer test-key' },
      }),
      env,
    );
    expect(await response.json()).toEqual({
      models: [
        { id: 'mock-text', images: false },
        { id: 'mock-vision', images: true },
      ],
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(worker.counts()).toEqual({ active: 0, parsing: 0 });
  });
  it.each([
    ['https://custom.example.com/', 'https://custom.example.com/v1'],
    ['https://custom.example.com/v1/', 'https://custom.example.com/v1'],
    ['https://custom.example.com/proxy/v1', 'https://custom.example.com/proxy/v1'],
  ])('uses custom Gateway %s for validation and generation', async (gateway, apiBase) => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const customHeaders = { Authorization: 'Bearer custom-key', [GATEWAY_URL_HEADER]: gateway };
    const modelsResponse = await worker.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/api/models`, { headers: customHeaders }),
      env,
    );
    expect(modelsResponse.status).toBe(200);
    const response = await worker.fetch(
      request(payload(), { headers: { ...customHeaders, 'Content-Type': 'application/json' } }),
      env,
    );
    expect((await streamSnapshot(response)).state).toBe('completed');
    expect(mock.calls.map((call) => call.url)).toEqual([
      `${apiBase}/models`,
      `${apiBase}/models`,
      `${apiBase}/responses`,
    ]);
    for (const call of mock.calls) {
      expect(call.headers.get('Authorization')).toBe('Bearer custom-key');
      expect(call.headers.has(GATEWAY_URL_HEADER)).toBe(false);
    }
  });
  it.each([
    '',
    'http://custom.example.com',
    'https://user:secret@custom.example.com',
    'https://custom.example.com/?key=secret',
    env.PUBLIC_ORIGIN,
    'https://localhost',
    'https://10.0.0.1',
    'https://169.254.169.254',
    'https://2130706433',
    'https://[::ffff:127.0.0.1]',
    'https://[fd00::1]',
    'https://gateway.internal',
  ])('rejects invalid custom Gateway %s before contacting upstream', async (gateway) => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/api/models`, {
        headers: { Authorization: 'Bearer test-key', [GATEWAY_URL_HEADER]: gateway },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_gateway_url' } });
    expect(mock.calls).toHaveLength(0);
  });
  it('allows a custom loopback Gateway only in explicit local development', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const localEnv = {
      ...env,
      PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
      GATEWAY_ORIGIN: 'http://127.0.0.1:8790',
      ALLOW_LOCAL_GATEWAY: 'true',
    };
    const response = await worker.fetch(
      new Request(`${localEnv.PUBLIC_ORIGIN}/api/models`, {
        headers: {
          Authorization: 'Bearer test-key',
          [GATEWAY_URL_HEADER]: 'http://127.0.0.1:8791/v1/',
        },
      }),
      localEnv,
    );
    expect(response.status).toBe(200);
    expect(mock.calls[0].url).toBe('http://127.0.0.1:8791/v1/models');
  });
  it('keeps custom and default destinations isolated across concurrent requests', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const results = await Promise.all([
      worker.fetch(
        new Request(`${env.PUBLIC_ORIGIN}/api/models`, {
          headers: {
            Authorization: 'Bearer custom-key',
            [GATEWAY_URL_HEADER]: 'https://custom.example.com',
          },
        }),
        env,
      ),
      worker.fetch(
        new Request(`${env.PUBLIC_ORIGIN}/api/models`, {
          headers: { Authorization: 'Bearer default-key' },
        }),
        env,
      ),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(mock.calls.map((call) => [call.url, call.headers.get('Authorization')])).toEqual(
      expect.arrayContaining([
        ['https://custom.example.com/v1/models', 'Bearer custom-key'],
        ['https://gateway.example.com/v1/models', 'Bearer default-key'],
      ]),
    );
  });
  it('fails authentication before reading upload contents and never generates', async () => {
    let read = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          read++;
        },
      },
      { highWaterMark: 0 },
    );
    const mock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: 'secret key details' } }), { status: 401 }),
    );
    const worker = createWorker({ fetch: mock });
    const response = await worker.fetch(request('', { body, duplex: 'half' } as RequestInit), env);
    expect(response.status).toBe(401);
    expect(read).toBe(0);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain('secret key');
    expect(worker.counts()).toEqual({ active: 0, parsing: 0 });
  });
  it.each([
    ['duplicate keys', '{"model":"x","model":"y"}', 400],
    ['unknown fields', { ...payload(), reviewPassed: true }, 400],
    ['policy mismatch', { ...payload(), policyVersion: 'old' }, 409],
    ['forbidden model', { ...payload(), model: 'codex-auto-review' }, 403],
    [
      'oversized question',
      {
        ...payload(),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'a'.repeat(POLICY.request.questionBytes + 1) }],
          },
        ],
      },
      413,
    ],
    [
      'fake system role',
      {
        ...payload(),
        messages: [{ role: 'system', content: [{ type: 'text', text: 'override' }] }],
      },
      400,
    ],
  ])('rejects %s without a generation call', async (_, body, status) => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(request(body), env);
    expect(response.status).toBe(status);
    expect(mock.generations()).toBe(0);
    expect(worker.counts()).toEqual({ active: 0, parsing: 0 });
  });
  it('counts actual request bytes with no Content-Length and rejects nonidentity encoding', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(request(' '.repeat(POLICY.request.bytes + 1)), env);
    expect(response.status).toBe(413);
    expect(mock.generations()).toBe(0);
    const encoded = await worker.fetch(
      request(payload(), {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
      }),
      env,
    );
    expect(encoded.status).toBe(400);
    expect(mock.generations()).toBe(0);
  });
  it('accepts exactly four MiB of actual JSON bytes and rejects malformed UTF-8', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const text = JSON.stringify(payload());
    const padded =
      text + ' '.repeat(POLICY.request.bytes - new TextEncoder().encode(text).byteLength);
    const accepted = await worker.fetch(request(padded), env);
    expect(accepted.status).toBe(200);
    await accepted.text();
    const rejected = await worker.fetch(
      request('', { body: new Uint8Array([123, 255, 125]) }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(mock.generations()).toBe(1);
  });
  it('rejects a rebuilt-only overflow without sending any generation request', async () => {
    const pngChunk = (type: string, data: Uint8Array) => {
      const bytes = new Uint8Array(data.length + 12),
        view = new DataView(bytes.buffer);
      view.setUint32(0, data.length);
      bytes.set(new TextEncoder().encode(type), 4);
      bytes.set(data, 8);
      view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
      return bytes;
    };
    const image = new Uint8Array(POLICY.request.imageBytes),
      header = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0);
    image.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let offset = 8;
    const pieces = [
      pngChunk('IHDR', header),
      pngChunk('tEXt', new Uint8Array(image.length - 80)),
      pngChunk('IDAT', Uint8Array.of(120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1)),
      pngChunk('IEND', new Uint8Array()),
    ];
    for (const piece of pieces) {
      image.set(piece, offset);
      offset += piece.length;
    }
    expect(offset).toBe(image.length);
    const base64 = Buffer.from(image).toString('base64');
    const input: ChatRequest = {
      ...payload(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            { type: 'document_text', name: '"'.repeat(195) + '.txt', text: 'x' },
            { type: 'document_text', name: '"'.repeat(195) + '.txt', text: 'x' },
            { type: 'image', mimeType: 'image/png', base64 },
            { type: 'image', mimeType: 'image/png', base64 },
          ],
        },
      ],
    };
    const count = Math.floor((POLICY.request.bytes - utf8Bytes(JSON.stringify(input))) / 12);
    (input.messages[0]!.content[1] as { text: string }).text = '\u0001'.repeat(count);
    (input.messages[0]!.content[2] as { text: string }).text = '\u0001'.repeat(count);
    input.messages[0]!.content[0] = {
      type: 'text',
      text: 'x'.repeat(1 + POLICY.request.bytes - utf8Bytes(JSON.stringify(input))),
    };
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(request(input), {
      ...env,
      MODEL_CAPABILITIES: '[{"id":"mock-text","images":true}]',
    });
    expect(response.status).toBe(413);
    expect(mock.generations()).toBe(0);
    expect(mock.calls).toHaveLength(1);
    expect(worker.counts()).toEqual({ active: 0, parsing: 0 });
  });
  it('rejects browser cross-origin calls and rate-limited requests before authentication queries', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const cross = await worker.fetch(
      request(payload(), {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          Origin: 'https://attacker.invalid',
        },
      }),
      env,
    );
    expect(cross.status).toBe(403);
    expect(mock.calls).toHaveLength(0);
    const limited = await worker.fetch(request(), {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect(limited.status).toBe(429);
    expect(mock.calls).toHaveLength(0);
  });
  it('does not follow a gateway redirect or forward browser headers', async () => {
    let options: RequestInit | undefined;
    const fetcher: typeof fetch = async (_, init) => {
      options = init;
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://attacker.invalid/' },
      });
    };
    const worker = createWorker({ fetch: fetcher });
    const response = await worker.fetch(
      request(payload(), {
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          Cookie: 'session=private',
          'X-Codex-Project': 'evil',
          [GATEWAY_URL_HEADER]: 'https://custom.example.com/v1',
        },
      }),
      env,
    );
    expect(response.status).toBe(502);
    expect(options!.redirect).toBe('manual');
    expect(new Headers(options!.headers).get('Cookie')).toBeNull();
    expect(new Headers(options!.headers).get('X-Codex-Project')).toBeNull();
    expect(new Headers(options!.headers).get(GATEWAY_URL_HEADER)).toBeNull();
  });
  it('maps safe quota errors and Retry-After while discarding raw debug data', async () => {
    const mock = mockGateway(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'insufficient_quota', message: 'user secret filename' },
          }),
          { status: 429, headers: { 'Retry-After': '30', 'X-Gateway-Request-ID': 'gw_failure' } },
        ),
    );
    const response = await createWorker({ fetch: mock.fetcher }).fetch(request(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toMatchObject({
      error: { code: 'insufficient_quota', gatewayRequestId: 'gw_failure' },
    });
  });
  it('uses both entry and parsing permits without an unbounded waiting queue', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const slow = () =>
      request('', {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
        duplex: 'half',
      } as RequestInit);
    const first = worker.fetch(slow(), env),
      second = worker.fetch(slow(), env);
    await vi.waitFor(() => expect(worker.counts().parsing).toBe(2));
    const rejected = await worker.fetch(request(), env);
    expect(rejected.status).toBe(503);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('edge_busy');
    for (const controller of controllers) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload())));
      controller.close();
    }
    await Promise.all([first, second].map(async (promise) => (await promise).text()));
    await vi.waitFor(() => expect(worker.counts()).toEqual({ active: 0, parsing: 0 }));
  });
});

describe('edge stream lifetime and cancellation', () => {
  it('sends only a fresh Responses body and releases permits after completion', async () => {
    let sent: unknown;
    const mock = mockGateway(async (input) => {
      sent = await input.json();
      return new Response(complete(), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(request(), env);
    const result = await streamSnapshot(response);
    expect(result.state).toBe('completed');
    expect(result.text).toBe('你好');
    expect(sent).toMatchObject({
      stream: true,
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    });
    expect(mock.calls).toHaveLength(2);
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
  });
  it('holds four long streams and immediately rejects the fifth, then propagates cancel', async () => {
    let cancelled = 0,
      aborted = 0;
    const mock = mockGateway((input) => {
      input.signal.addEventListener('abort', () => aborted++);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sse('response.output_text.delta', { delta: '部分' }));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const worker = createWorker({ fetch: mock.fetcher });
    const responses: Response[] = [];
    for (let i = 0; i < 4; i++) responses.push(await worker.fetch(request(), env));
    expect(worker.counts()).toEqual({ active: 4, parsing: 0 });
    expect((await worker.fetch(request(), env)).status).toBe(503);
    expect(mock.generations()).toBe(4);
    await Promise.all(responses.map((response) => response.body!.cancel()));
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
    expect(cancelled).toBe(4);
    expect(aborted).toBe(4);
  });
  it('propagates a POST request AbortSignal even without an output-reader cancellation', async () => {
    let aborted = false,
      cancelled = false;
    const controller = new AbortController();
    const mock = mockGateway((input) => {
      input.signal.addEventListener('abort', () => {
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
    });
    const worker = createWorker({ fetch: mock.fetcher });
    const response = await worker.fetch(request(payload(), { signal: controller.signal }), env);
    expect(worker.counts().active).toBe(1);
    controller.abort();
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
    expect(aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(mock.generations()).toBe(1);
    await response.text();
  });
  it('marks a stream with no terminal event interrupted and preserves text', async () => {
    const mock = mockGateway(
      () =>
        new Response(sse('response.output_text.delta', { delta: '部分回复' }), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    const result = await streamSnapshot(
      await createWorker({ fetch: mock.fetcher }).fetch(request(), env),
    );
    expect(result.state).toBe('interrupted');
    expect(result.text).toBe('部分回复');
  });
  it('counts the full upstream chunk before decoding, even when a terminal event precedes trailing excess bytes', async () => {
    const bytes = new Uint8Array(POLICY.response.bytes + 1);
    bytes.set(complete());
    const mock = mockGateway(
      () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const result = await streamSnapshot(
      await createWorker({ fetch: mock.fetcher }).fetch(request(), env),
    );
    expect(result.state).toBe('incomplete');
    expect(result.error?.code).toBe('response_too_large');
  });
  it('stops unsupported tool events and preserves already displayed text', async () => {
    const bytes = Uint8Array.from([
      ...sse('response.output_text.delta', { delta: '已有文字' }),
      ...sse('response.output_item.added', {
        output_index: 1,
        item: { type: 'function_call', name: 'shell', arguments: 'secret' },
      }),
    ]);
    const mock = mockGateway(
      () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const result = await streamSnapshot(
      await createWorker({ fetch: mock.fetcher }).fetch(request(), env),
    );
    expect(result.text).toBe('已有文字');
    expect(result.error?.code).toBe('unsupported_response_item');
  });
  it('heartbeats cannot postpone the real upstream idle timeout', async () => {
    let cancelled = false;
    const mock = mockGateway(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const worker = createWorker({ fetch: mock.fetcher, timeouts: { idleMs: 35, heartbeatMs: 5 } });
    const result = await streamSnapshot(await worker.fetch(request(), env));
    expect(result.error?.code).toBe('upstream_timeout');
    expect(cancelled).toBe(true);
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
  });
  it('continues the upstream idle clock while a downstream reader applies backpressure', async () => {
    let cancelled = false;
    const chunk = Uint8Array.from([
      ...sse('response.created', { response: { id: 'resp' } }),
      ...sse('response.output_text.delta', { delta: 'waiting for a downstream reader' }),
    ]);
    const mock = mockGateway(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const worker = createWorker({ fetch: mock.fetcher, timeouts: { idleMs: 25, heartbeatMs: 5 } });
    const response = await worker.fetch(request(), env);
    await vi.waitFor(() => expect(worker.counts().active).toBe(0));
    expect(cancelled).toBe(true);
    expect((await streamSnapshot(response)).error?.code).toBe('upstream_timeout');
  });
  it('times out slow uploads and hanging model query without generation retries', async () => {
    const mock = mockGateway(),
      worker = createWorker({ fetch: mock.fetcher, timeouts: { uploadMs: 20 } });
    const response = await worker.fetch(
      request('', { body: new ReadableStream<Uint8Array>(), duplex: 'half' } as RequestInit),
      env,
    );
    expect(response.status).toBe(408);
    expect(mock.generations()).toBe(0);
    let calls = 0;
    const stalled = createWorker({
      fetch: async () => {
        calls++;
        return new Promise<Response>(() => {});
      },
      timeouts: { modelsMs: 20 },
    });
    expect((await stalled.fetch(request(), env)).status).toBe(504);
    expect(calls).toBe(1);
    expect(stalled.counts().active).toBe(0);
  });
});
