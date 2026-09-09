import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  APPLICATION_INSTRUCTIONS,
  APP_CONTRACT_VERSION,
  ContractError,
  POLICY,
  POLICY_VERSION,
  ResponseReconciler,
  SSEParser,
  crc32,
  encodeSSE,
  inspectImage,
  parseStrictJson,
  rebuildGatewayRequest,
  sanitizedResponsesEvent,
  strictBase64,
  utf8Bytes,
  validFilename,
  validateChatRequest,
  type ChatRequest,
  type SSEEvent,
} from './index';

const question = (text = '你好'): ChatRequest => ({
  schemaVersion: APP_CONTRACT_VERSION,
  policyVersion: POLICY_VERSION,
  clientRequestId: '00000000-0000-4000-8000-000000000001',
  model: 'mock-text',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
});
function event(type: string, fields: Record<string, unknown>): SSEEvent {
  return { event: type, data: JSON.stringify({ type, ...fields }) };
}
function chunk(type: string, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.length + 12),
    view = new DataView(result.buffer);
  view.setUint32(0, body.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(body, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}
function png(width = 1, height = 1, extras: Uint8Array[] = []): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pieces = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    ...extras,
    chunk('IDAT', deflateSync(Uint8Array.of(0, 0, 0, 0, 0))),
    chunk('IEND', new Uint8Array()),
  ];
  return Uint8Array.from(pieces.flatMap((piece) => [...piece]));
}

describe('strict request contracts', () => {
  it('rejects repeated keys including escaped aliases, unknown fields and excessive depth', () => {
    expect(() => parseStrictJson('{"x":1,"\\u0078":2}')).toThrow();
    expect(() => parseStrictJson('['.repeat(17) + '0' + ']'.repeat(17), 16)).toThrow();
    expect(parseStrictJson('['.repeat(16) + '0' + ']'.repeat(16), 16)).toBeDefined();
    expect(() => validateChatRequest({ ...question(), reviewPassed: true })).toThrow();
    expect(() => parseStrictJson('{"x":0,}')).toThrow();
    expect(() => parseStrictJson('{"x":01}')).toThrow();
  });
  it('checks UTF-8 bytes at the question boundary, not UTF-16 length', () => {
    for (const count of [POLICY.request.questionBytes - 1, POLICY.request.questionBytes])
      expect(validateChatRequest(question('a'.repeat(count)))).toBeDefined();
    expect(() =>
      validateChatRequest(question('a'.repeat(POLICY.request.questionBytes + 1))),
    ).toThrow(ContractError);
    expect(() => validateChatRequest(question('汉'.repeat(11_000)))).toThrow();
    expect(utf8Bytes('汉🙂')).toBe(7);
  });
  it('enforces one ordinary text block, last user and assistant text only', () => {
    const request = question();
    request.messages[0]!.content.push({ type: 'text', text: 'extra' });
    expect(() => validateChatRequest(request)).toThrow();
    expect(() =>
      validateChatRequest({
        ...question(),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
      }),
    ).toThrow();
    expect(() =>
      validateChatRequest({
        ...question(),
        messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }],
      }),
    ).toThrow();
  });
  it('checks whole-history totals and does not trust metadata', () => {
    const request = question();
    request.messages.unshift(
      ...Array.from({ length: 3 }, () => ({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'x'.repeat(192 * 1024) }],
      })),
    );
    expect(() => validateChatRequest(request)).toThrow();
    expect(() => validateChatRequest({ ...question(), policyVersion: 'old' })).toThrow(/策略/);
    expect(() => validateChatRequest(question(), { models: [] })).toThrow(/模型/);
  });
  it('rebuilds only allowed Responses fields and accounts source labels', () => {
    const request = question();
    request.messages[0]!.content.push({
      type: 'document_text',
      name: '文件".txt',
      text: '<untrusted>',
    });
    const body = JSON.parse(rebuildGatewayRequest(validateChatRequest(request)));
    expect(body).toMatchObject({ model: 'mock-text', stream: true, store: false });
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream']);
    expect(body.input[0].content[1].text).toContain('文件\\".txt');
    expect(body.instructions).not.toContain('<untrusted>');
    expect(validFilename('..\\secret')).toBe(false);
    expect(validFilename('x\u202etxt')).toBe(false);
    expect(validFilename('文'.repeat(200))).toBe(true);
  });
  it('rejects only after rebuilding when escaped source labels push a valid inbound body over four MiB', () => {
    const encoded = Buffer.from(
      png(1, 1, [chunk('tEXt', new Uint8Array(POLICY.request.imageBytes - png().length - 12))]),
    ).toString('base64');
    const request = question('x');
    request.messages[0]!.content.push(
      { type: 'document_text', name: '"'.repeat(195) + '.txt', text: 'x' },
      { type: 'document_text', name: '"'.repeat(195) + '.txt', text: 'x' },
      { type: 'image', mimeType: 'image/png', base64: encoded },
      { type: 'image', mimeType: 'image/png', base64: encoded },
    );
    const remaining = POLICY.request.bytes - utf8Bytes(JSON.stringify(request));
    const count = Math.floor(remaining / 12);
    (request.messages[0]!.content[1] as { text: string }).text = '\u0001'.repeat(count);
    (request.messages[0]!.content[2] as { text: string }).text = '\u0001'.repeat(count);
    request.messages[0]!.content[0] = {
      type: 'text',
      text: 'x'.repeat(1 + POLICY.request.bytes - utf8Bytes(JSON.stringify(request))),
    };
    expect(utf8Bytes(JSON.stringify(request))).toBe(POLICY.request.bytes);
    const validated = validateChatRequest(request, {
      images: true,
      models: [{ id: 'mock-text', images: true }],
    });
    expect(() => rebuildGatewayRequest(validated)).toThrow(/限制/);
  });
  it('checks message count, total blocks and context text at minus-one, exact and plus-one', () => {
    for (const length of [79, 80, 81]) {
      const request = question();
      request.messages.unshift(
        ...Array.from({ length: length - 1 }, () => ({
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'history' }],
        })),
      );
      if (length <= 80) expect(validateChatRequest(request)).toBeDefined();
      else expect(() => validateChatRequest(request)).toThrow();
    }
    for (const difference of [-1, 0, 1]) {
      const request = question('x');
      const available =
        POLICY.request.textBytes - utf8Bytes(APPLICATION_INSTRUCTIONS) - 1 + difference;
      request.messages.unshift(
        ...[192 * 1024, 192 * 1024, available - 384 * 1024].map((length) => ({
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'x'.repeat(length) }],
        })),
      );
      if (difference <= 0) expect(validateChatRequest(request)).toBeDefined();
      else expect(() => validateChatRequest(request)).toThrow();
    }
    for (const blockCount of [127, 128, 129]) {
      const request = question('x');
      let remaining = blockCount - 1;
      while (remaining > 0) {
        const documents = Math.min(4, remaining - 1);
        request.messages.unshift({
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            ...Array.from({ length: documents }, () => ({
              type: 'document_text' as const,
              name: 'x.txt',
              text: 'x',
            })),
          ],
        });
        remaining -= documents + 1;
      }
      if (blockCount <= 128) expect(validateChatRequest(request)).toBeDefined();
      else expect(() => validateChatRequest(request)).toThrow();
    }
  });
  it('enforces document bytes, last-message document totals and whole-context image count', () => {
    for (const difference of [-1, 0, 1]) {
      const request = question();
      request.messages[0]!.content.push({
        type: 'document_text',
        name: 'x.txt',
        text: 'x'.repeat(POLICY.parsing.documentTextBytes + difference),
      });
      if (difference <= 0) expect(validateChatRequest(request)).toBeDefined();
      else expect(() => validateChatRequest(request)).toThrow();
    }
    const request = question();
    request.messages[0]!.content.push(
      ...Array.from({ length: 2 }, () => ({
        type: 'document_text' as const,
        name: 'x.txt',
        text: 'x'.repeat(POLICY.parsing.documentTextBytes),
      })),
    );
    expect(validateChatRequest(request)).toBeDefined();
    request.messages[0]!.content.push({ type: 'document_text', name: 'x.txt', text: 'x' });
    expect(() => validateChatRequest(request)).toThrow();
    const encoded = Buffer.from(png()).toString('base64');
    for (const imageCount of [1, 2, 3]) {
      const input = question();
      input.messages[0]!.content.push(
        ...Array.from({ length: imageCount }, () => ({
          type: 'image' as const,
          mimeType: 'image/png' as const,
          base64: encoded,
        })),
      );
      if (imageCount <= 2) expect(validateChatRequest(input)).toBeDefined();
      else expect(() => validateChatRequest(input)).toThrow();
    }
  });
});

describe('normalized image verification', () => {
  it('validates canonical Base64 and declared/actual encoded byte boundaries', () => {
    expect([...strictBase64('YQ==', 1)]).toEqual([97]);
    for (const value of ['YQ', 'YR==', 'YQ==\n', '____', 'YQ===', ''])
      expect(() => strictBase64(value)).toThrow();
    expect(() => strictBase64('YWI=', 1)).toThrow();
  });
  it('accepts static PNG and rejects CRC damage, animation, forged dimensions and trailing data', () => {
    expect(inspectImage(png(), 'image/png')).toMatchObject({ width: 1, height: 1 });
    const corrupt = png();
    corrupt[29] = corrupt[29]! ^ 1;
    expect(() => inspectImage(corrupt, 'image/png')).toThrow();
    expect(() =>
      inspectImage(png(1, 1, [chunk('acTL', new Uint8Array(8))]), 'image/png'),
    ).toThrow();
    expect(() => inspectImage(png(2049, 1), 'image/png')).toThrow();
    expect(inspectImage(png(2048, 2048), 'image/png')).toMatchObject({ width: 2048, height: 2048 });
    expect(() => inspectImage(Uint8Array.from([...png(), 0]), 'image/png')).toThrow();
    expect(() => inspectImage(png(), 'image/jpeg')).toThrow();
  });
});

describe('SSE boundaries and Responses reconciliation', () => {
  it('decodes UTF-8 byte splits, CRLF, standalone CR, multi-line data and comments', () => {
    const raw =
      ': heartbeat\r\nevent: custom\r\ndata: {"text":\r\ndata: "你好🙂"}\r\n\r\nevent: other\rdata: {}\r\r';
    const parser = new SSEParser();
    const events = [...new TextEncoder().encode(raw)].flatMap((byte) =>
      parser.push(Uint8Array.of(byte)),
    );
    events.push(...parser.finish());
    expect(events).toEqual([
      { event: 'custom', data: '{"text":\n"你好🙂"}' },
      { event: 'other', data: '{}' },
    ]);
  });
  it('enforces raw total/event size including comments and CRLF', () => {
    const bytes = new TextEncoder().encode('data: x\r\n\r\n');
    expect(
      new SSEParser({ maxEventBytes: bytes.length, maxBytes: bytes.length }).push(bytes),
    ).toHaveLength(1);
    expect(() => new SSEParser({ maxEventBytes: bytes.length - 1 }).push(bytes)).toThrow();
    expect(() =>
      new SSEParser({ maxBytes: 4 }).push(new TextEncoder().encode(': hi\n\n')),
    ).toThrow();
    expect(() => new SSEParser().push(Uint8Array.of(255))).toThrow();
  });
  it('yields one event before parsing later oversized events in the same network chunk', () => {
    const parser = new SSEParser({ maxEventBytes: 32 });
    const stream = parser.iterate(
      new TextEncoder().encode('data: first\n\ndata: ' + 'x'.repeat(33) + '\n\n'),
    );
    expect(stream.next().value).toEqual({ event: 'message', data: 'first' });
    expect(() => stream.next()).toThrow(/限制/);
    let count = 0;
    for (const event of new SSEParser().iterate(
      new TextEncoder().encode('data: {}\n\n'.repeat(100_000)),
    )) {
      expect(event.data).toBe('{}');
      count++;
    }
    expect(count).toBe(100_000);
  });
  it('reconciles final-only and incremental multi-item/multi-part text without duplicates', () => {
    const edge = new ResponseReconciler(),
      browser = new ResponseReconciler();
    const events = [
      event('response.output_text.delta', { output_index: 0, content_index: 0, delta: '你' }),
      event('response.output_text.done', { output_index: 0, content_index: 0, text: '你好' }),
      event('response.output_text.delta', { output_index: 1, content_index: 1, delta: 'B' }),
      event('response.completed', {
        response: {
          id: 'resp_test',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '你好' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'A' },
                { type: 'output_text', text: 'B' },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
          debug_secret: 'never forward',
        },
      }),
    ];
    for (const original of events) {
      const snapshot = edge.consume(original);
      const forwarded = sanitizedResponsesEvent(original, snapshot, 'web-id', 'gateway-id');
      if (forwarded) {
        expect(forwarded.data).not.toContain('debug_secret');
        browser.consume(forwarded);
      }
    }
    expect(edge.snapshot.text).toBe('你好AB');
    expect(browser.snapshot.text).toBe(edge.snapshot.text);
    expect(browser.snapshot.state).toBe('completed');
  });
  it('detects conflicting final text, unsupported output and incomplete termination', () => {
    const model = new ResponseReconciler();
    model.consume(event('response.output_text.delta', { delta: 'hello' }));
    expect(() =>
      model.consume(event('response.output_text.done', { text: 'different' })),
    ).toThrow();
    expect(() =>
      new ResponseReconciler().consume(
        event('response.output_item.added', { item: { type: 'function_call', name: 'shell' } }),
      ),
    ).toThrow(/不支持/);
    expect(new ResponseReconciler().finish().state).toBe('interrupted');
    expect(() =>
      new ResponseReconciler(2).consume(event('response.output_text.delta', { delta: '汉' })),
    ).toThrow();
    const missing = new ResponseReconciler();
    missing.consume(event('response.output_text.delta', { delta: 'unspecified final text' }));
    expect(() =>
      missing.consume(event('response.completed', { response: { output: [] } })),
    ).toThrow();
    expect(() =>
      new ResponseReconciler().consume(
        event('response.created', { response: { output: [{ type: 'function_call' }] } }),
      ),
    ).toThrow(/不支持/);
    expect(() =>
      new ResponseReconciler().consume(
        event('response.completed', { response: { status: 'failed', output: [] } }),
      ),
    ).toThrow();
  });
  it('shows refusals and ignores bounded non-executable metadata', () => {
    const model = new ResponseReconciler();
    model.consume(event('response.new_metadata', { harmless: true }));
    model.consume(event('response.refusal.delta', { delta: '无法帮助' }));
    model.consume(event('response.refusal.done', { refusal: '无法帮助这件事。' }));
    const result = model.consume(
      event('response.completed', {
        response: {
          output: [
            { type: 'message', content: [{ type: 'refusal', refusal: '无法帮助这件事。' }] },
          ],
        },
      }),
    );
    expect(result.state).toBe('completed');
    expect(result.text).toBe('无法帮助这件事。');
  });
  it('keeps safe error codes while stripping raw upstream errors', () => {
    const original = event('response.failed', {
      response: { output: [], error: { message: 'Bearer secret', stack: 'debug' } },
    });
    const model = new ResponseReconciler();
    const forwarded = sanitizedResponsesEvent(
      original,
      model.consume(original),
      'request',
      'gateway',
    );
    expect(forwarded!.data).not.toContain('secret');
    expect(forwarded!.event).toBe('webchat.error');
    expect(new SSEParser().push(encodeSSE(forwarded!))).toHaveLength(1);
  });
});
