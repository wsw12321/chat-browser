import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseDocx } from '../src/docx';
import { inspectZip, inflateEntries, crc32 } from '../src/zip';
import { docx, wordNamespace } from './fixture-builders';
const context = () => ({ resources: new Set<() => void>(), progress() {}, check() {} });
describe('bounded ZIP structure and incremental CRC', () => {
  it('accepts stored and deflated entries and checks every entry', () => {
    for (const level of [0, 6] as const) {
      const bytes = docx(undefined, {}, level),
        entries = inspectZip(bytes);
      let total = 0;
      inflateEntries(bytes, entries, (_entry, chunk) => (total += chunk.length));
      expect(total).toBe(entries.reduce((sum, e) => sum + e.size, 0));
    }
  });
  it('rejects traversal, duplicate logical paths and nested archives', () => {
    expect(() => inspectZip(zipSync({ '../x': strToU8('x') }, { level: 0 }))).toThrow();
    expect(() =>
      inspectZip(zipSync({ 'x/': new Uint8Array(), x: strToU8('x') }, { level: 0 })),
    ).toThrow();
    expect(() => inspectZip(zipSync({ 'x.zip': strToU8('x') }, { level: 0 }))).toThrow();
  });
  it('rejects case-conflicting paths and embedded OLE disguised as an unused part', () => {
    expect(() =>
      inspectZip(zipSync({ 'a.xml': strToU8('<a/>'), 'A.xml': strToU8('<a/>') }, { level: 0 })),
    ).toThrow('document_unverifiable');
    expect(() =>
      parseDocx(
        docx(undefined, { 'word/unused.bin': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) }),
        context(),
      ),
    ).toThrow('active_content_not_allowed');
  });
  it('rejects actual corruption even in unused parts', () => {
    const bytes = docx(undefined, { 'word/unused.bin': 'harmless' }),
      entries = inspectZip(bytes);
    bytes[entries.at(-1)!.start] ^= 1;
    expect(() => inflateEntries(bytes, entries, () => {})).toThrow('document_unverifiable');
  });
  it('rejects entry length disagreement before decompression', () => {
    const bytes = docx(),
      view = new DataView(bytes.buffer);
    view.setUint32(22, 123, true);
    expect(() => inspectZip(bytes)).toThrow('document_unverifiable');
  });
  it('rejects ZIP64, encrypted and fake local headers', () => {
    for (const update of [
      (view: DataView) => view.setUint16(bytesLength - 12, 0xffff, true),
      (view: DataView) => view.setUint16(6, 1, true),
      (view: DataView) => view.setUint32(0, 0, true),
    ]) {
      const bytes = docx();
      const bytesLengthLocal = bytes.length;
      void bytesLengthLocal;
      var bytesLength = bytes.length;
      update(new DataView(bytes.buffer));
      expect(() => inspectZip(bytes)).toThrow();
    }
  });
  it('enforces expansion budgets before and during inflate with tiny test limits', () => {
    const bytes = docx();
    expect(() => inspectZip(bytes, { entries: 2, total: 10000, entry: 10000, ratio: 100 })).toThrow(
      'archive_expansion_limit',
    );
    const entries = inspectZip(bytes);
    expect(() =>
      inflateEntries(
        bytes,
        entries,
        () => {},
        () => {},
        { entries: 512, total: 10, entry: 10, ratio: 100 },
      ),
    ).toThrow('archive_expansion_limit');
  });
  it('CRC streaming equals known standard value', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(crc32(strToU8('56789'), crc32(strToU8('1234')))).toBe(0xcbf43926);
  });
});
describe('restricted DOCX XML', () => {
  it('extracts paragraphs and simple tables in document order', () => {
    const parsed = parseDocx(
      docx(
        '<w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ),
      context(),
    );
    expect(parsed.text).toMatch(/Heading\nA\n\tB/);
    expect(parsed.metrics.tableCells).toBe(2);
  });
  it('requires actual DOCX content type and main relationship', () => {
    expect(() => parseDocx(zipSync({ 'x.xml': strToU8('<x/>') }), context())).toThrow(
      'file_type_mismatch',
    );
    expect(() =>
      parseDocx(
        docx(undefined, {
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
        }),
        context(),
      ),
    ).toThrow('active_content_not_allowed');
  });
  it.each([
    '<!DOCTYPE x [<!ENTITY test "x">]><x/>',
    '<x>'.repeat(65) + '</x>'.repeat(65),
    '<?xml version="1.0" encoding="UTF-16"?><x/>',
  ])('rejects unsafe or excessive XML in unused parts', (xml) =>
    expect(() => parseDocx(docx(undefined, { 'word/extra.xml': xml }), context())).toThrow(),
  );
  it.each([
    '<w:tbl><w:tr><w:tc><w:tbl/></w:tc></w:tr></w:tbl>',
    '<w:ins><w:r><w:t>change</w:t></w:r></w:ins>',
    '<w:txbxContent/>',
    '<w:object/>',
    '<w:commentReference/>',
  ])('rejects prohibited document structure', (body) =>
    expect(() => parseDocx(docx(body), context())).toThrow('document_too_complex'),
  );
  it('checks events across XML parts and invalid UTF-8', () => {
    expect(() =>
      parseDocx(docx(undefined, { 'word/extra.xml': new Uint8Array([0xff, 0xfe]) }), context()),
    ).toThrow('document_unverifiable');
    expect(() =>
      parseDocx(
        docx(undefined, { 'word/extra.xml': '<x>' + '<a/>'.repeat(100001) + '</x>' }, 0),
        context(),
      ),
    ).toThrow();
  });
  it('rejects external templates but keeps external hyperlink visible text without fetching', () => {
    const rel = (type: string) =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://attacker.invalid/resource" TargetMode="External"/></Relationships>`;
    expect(() =>
      parseDocx(
        docx(undefined, { 'word/_rels/document.xml.rels': rel('attachedTemplate') }),
        context(),
      ),
    ).toThrow('active_content_not_allowed');
    expect(
      parseDocx(
        docx('<w:hyperlink><w:r><w:t>Visible link</w:t></w:r></w:hyperlink>', {
          'word/_rels/document.xml.rels': rel('hyperlink'),
        }),
        context(),
      ).text,
    ).toContain('Visible link');
  });
  it('requires image loss confirmation and labels separate ancillary text', () => {
    const parsed = parseDocx(
      docx('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', {
        'word/media/a.png': new Uint8Array([137, 80, 78, 71]),
        'word/header1.xml': `<w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`,
      }),
      context(),
    );
    expect(parsed.warnings[0]).toContain('图片未分析');
    expect(parsed.text).toContain('[页眉：word/header1.xml]');
  });
});
