import { describe, it, expect } from 'vitest';
import { parseText, decodeUtf8 } from '../src/text';
import { precheckBatch, precheckFile } from '../src/preflight';
import { LIMITS } from '../src/types';
const bytes = (text: string) => new TextEncoder().encode(text);
describe('local preflight', () => {
  it('accepts empty MIME and checks raw bytes before reading', () => {
    expect(precheckFile({ name: 'a.txt', type: '', size: 1 })).toBe('txt');
    expect(() => precheckFile({ name: 'a.txt', type: 'image/png', size: 1 })).toThrow(
      'file_type_mismatch',
    );
  });
  it.each([LIMITS.textFile - 1, LIMITS.textFile])('accepts text file byte bound %i', (size) =>
    expect(precheckFile({ name: 'a.txt', type: '', size })).toBe('txt'),
  );
  it('rejects count, byte and image batch overflows as a whole', () => {
    expect(() =>
      precheckBatch(Array.from({ length: 5 }, () => ({ name: 'a.txt', type: '', size: 1 }))),
    ).toThrow('attachment_batch_too_large');
    expect(() => precheckBatch([{ name: 'a.pdf', type: '', size: LIMITS.batchBytes + 1 }])).toThrow(
      'attachment_batch_too_large',
    );
    expect(() =>
      precheckBatch(Array.from({ length: 3 }, () => ({ name: 'a.png', type: '', size: 1 }))),
    ).toThrow('attachment_batch_too_large');
  });
  it('rejects unsupported, contradictory, control and oversized inputs', () => {
    for (const name of ['a.exe', 'a.xlsx', 'x\u202ey.txt', '../a.txt', 'a\u0000.txt'])
      expect(() => precheckFile({ name, type: '', size: 1 })).toThrow();
    expect(() => precheckFile({ name: 'a.txt', type: '', size: LIMITS.textFile + 1 })).toThrow(
      'file_too_large',
    );
    expect(() => precheckFile({ name: 'a.txt', type: '', size: 0 })).toThrow();
  });
});
describe('strict bounded text', () => {
  it('strictly accepts BOM and normalizes CRLF', () =>
    expect(parseText(new Uint8Array([239, 187, 191, ...bytes('你好\r\nworld')]), 'txt').text).toBe(
      '你好\nworld',
    ));
  it('rejects invalid UTF-8 and binary NUL', () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => parseText(bytes('hello\0'), 'txt')).toThrow();
  });
  it.each([LIMITS.text - 1, LIMITS.text])('accepts normalized output %i', (size) =>
    expect(parseText(bytes('x'.repeat(size)), 'txt').text?.length).toBe(size),
  );
  it('measures UTF-8 output bytes and never truncates', () =>
    expect(() => parseText(bytes('汉'.repeat(LIMITS.text / 3 + 1)), 'md')).toThrow(
      'extracted_text_too_large',
    ));
  it('bounds JSON depth before parse, permits strings containing braces', () => {
    expect(parseText(bytes('['.repeat(32) + '0' + ']'.repeat(32)), 'json').text).toBeTruthy();
    expect(() => parseText(bytes('['.repeat(33) + '0' + ']'.repeat(33)), 'json')).toThrow(
      'document_too_complex',
    );
    expect(parseText(bytes('{"text":"[[[["}'), 'json').text).toBeTruthy();
    expect(() => parseText(bytes('{"bad":}'), 'json')).toThrow();
  });
  it('CSV supports quoted delimiters, escaped quotes, embedded lines and literal formulas', () => {
    const parsed = parseText(bytes('a,b\n"x,y","a\n""b"""\n=SUM(A1),+1'), 'csv');
    expect(parsed.metrics.rows).toBe(3);
    expect(parsed.metrics.columns).toBe(2);
    expect(parsed.text).toContain('=SUM(A1)');
  });
  it('counts empty CSV columns and bounds decoded quote/UTF-8 cell bytes', () => {
    expect(() => parseText(bytes(','.repeat(50)), 'csv')).toThrow('document_too_complex');
    expect(parseText(bytes('"' + '""'.repeat(8192) + '"'), 'csv').metrics.rows).toBe(1);
    expect(() => parseText(bytes('"' + '""'.repeat(8193) + '"'), 'csv')).toThrow(
      'document_too_complex',
    );
  });
  it('CSV limits columns, cells and cell bytes during parsing', () => {
    expect(() => parseText(bytes(Array(51).fill('a').join(',')), 'csv')).toThrow(
      'document_too_complex',
    );
    expect(() => parseText(bytes('"' + 'x'.repeat(8193) + '"'), 'csv')).toThrow(
      'document_too_complex',
    );
    expect(() => parseText(bytes(Array(2001).fill('a').join('\n')), 'csv')).toThrow(
      'document_too_complex',
    );
    expect(() => parseText(bytes('"unterminated'), 'csv')).toThrow('document_parse_failed');
  });
});
