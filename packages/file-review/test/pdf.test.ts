import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parsePdf, checkPdfReport, PDF_REVIEW_VERSION } from '../src/pdf';
import { pdf } from './fixture-builders';
const context = () => ({
  resources: new Set<() => void | Promise<void>>(),
  progress() {},
  check() {},
});
describe('pinned PDF review patch', () => {
  it('fails closed without the read-only review method or matching patch marker', async () => {
    await expect(checkPdfReport({} as never)).rejects.toThrow('document_unverifiable');
    await expect(
      checkPdfReport({
        getWebchatReview: async () => ({ version: 'wrong', ok: true, checked: 1 }),
      } as never),
    ).rejects.toThrow('document_unverifiable');
    expect(PDF_REVIEW_VERSION).toBe('pdfjs-6.3.289-review1');
  });
  it('ships matching source patches and no dynamic evaluator', () => {
    const require = createRequire(import.meta.url),
      worker = readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
    expect(worker).toContain('function webchatReviewStructure(');
    expect(worker).toContain('xref.countUpdatesAfter(0)');
    expect(worker).not.toMatch(/new Function\(|\beval\(/);
  });
  it('extracts ordinary text and always reports PDF text-only loss', async () => {
    const ctx = context(),
      result = await parsePdf(pdf(), ctx);
    expect(result.text).toContain('ordinary document');
    expect(result.warnings[0]).toContain('图表');
    expect(ctx.resources.size).toBe(0);
  });
  it('accepts local destination and navigation open actions', async () => {
    for (const catalog of [
      '/OpenAction [4 0 R /Fit]',
      '/OpenAction << /S /GoTo /D [4 0 R /Fit] >>',
      '/OpenAction << /S /Named /N /NextPage >>',
    ])
      expect((await parsePdf(pdf({ catalog }), context())).text).toBeTruthy();
  });
  it.each([
    'JavaScript',
    'Launch',
    'SubmitForm',
    'ImportData',
    'URI',
    'GoToR',
    'GoToE',
    'Rendition',
    'SetOCGState',
  ])('rejects raw OpenAction %s even where public conversion drops it', async (type) => {
    await expect(
      parsePdf(
        pdf({
          catalog: `/OpenAction << /S /${type} /JS (app.alert) /F (payload) /URI (https://bad.invalid) >>`,
        }),
        context(),
      ),
    ).rejects.toThrow('active_content_not_allowed');
  });
  it('rejects chained actions, additional actions, and outline actions', async () => {
    for (const catalog of [
      '/OpenAction << /S /GoTo /D [4 0 R /Fit] /Next << /S /Launch /F (x) >> >>',
      '/AA << /WC << /S /SubmitForm >> >>',
      '/Outlines << /First << /A << /S /JavaScript /JS (x) >> >> >>',
    ])
      await expect(parsePdf(pdf({ catalog }), context())).rejects.toThrow(
        'active_content_not_allowed',
      );
  });
  it.each([
    '/Names << /JavaScript << /Names [] >> >>',
    '/Names << /EmbeddedFiles << /Names [] >> >>',
    '/AcroForm << /Fields [<< /FT /Tx /T (name) >>] >>',
    '/AcroForm << /XFA (hidden) /Fields [] >>',
    '/AF []',
  ])('rejects catalog scripts, attachments and forms', async (catalog) =>
    expect(parsePdf(pdf({ catalog }), context())).rejects.toThrow('active_content_not_allowed'),
  );
  it.each([
    '/AA << /O << /S /JavaScript /JS (x) >> >>',
    '/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /Launch >> >>]',
    '/Annots [<< /Type /Annot /Subtype /Widget /Rect [0 0 1 1] >>]',
    '/Annots [<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 1 1] >>]',
  ])('checks page actions and raw annotations', async (page) =>
    expect(parsePdf(pdf({ page }), context())).rejects.toThrow('active_content_not_allowed'),
  );
  it('finds associated files in structure elements and active popup parents', async () => {
    await expect(
      parsePdf(
        pdf({
          catalog:
            '/StructTreeRoot << /Type /StructTreeRoot /K << /Type /StructElem /S /P /AF [<< /Type /Filespec /F (hidden.txt) /EF << /F 6 0 R >> >>] >> >>',
          objects: ['<< /Type /EmbeddedFile /Length 1 >>\nstream\nx\nendstream'],
        }),
        context(),
      ),
    ).rejects.toThrow('active_content_not_allowed');
    await expect(
      parsePdf(
        pdf({
          page: '/Annots [<< /Subtype /Popup /Rect [0 0 1 1] /Parent << /Subtype /FileAttachment /FS << /Type /Filespec /F (x) >> >> >>]',
        }),
        context(),
      ),
    ).rejects.toThrow('active_content_not_allowed');
  });
  it('rejects unknown review structure and broken cross-reference recovery', async () => {
    await expect(
      parsePdf(pdf({ catalog: '/OpenAction << /D [4 0 R /Fit] >>' }), context()),
    ).rejects.toThrow('document_unverifiable');
    await expect(parsePdf(pdf({ brokenXref: true }), context())).rejects.toThrow(
      'document_unverifiable',
    );
  });
  it('enforces pages 40/41 and OCR threshold', async () => {
    expect((await parsePdf(pdf({ pages: 40 }), context())).metrics.pages).toBe(40);
    await expect(parsePdf(pdf({ pages: 41 }), context())).rejects.toThrow(
      'document_too_many_pages',
    );
    await expect(parsePdf(pdf({ text: 'too little' }), context())).rejects.toThrow(
      'document_requires_ocr',
    );
  });
  it('destroys resources when task cancellation is observed', async () => {
    const ctx = context();
    ctx.check = vi.fn(() => {
      throw new Error('cancel');
    });
    await expect(parsePdf(pdf(), ctx)).rejects.toThrow('document_unverifiable');
    expect(ctx.resources.size).toBe(0);
  });
});
