import './pdf-runtime';
import { getDocument, version, type PDFDocumentProxy } from 'pdfjs-dist';
// Bundled into this dedicated review worker. PDF.js sees its installed handler and uses
// its loopback port; it never creates an untracked nested worker or a blob: script.
import 'pdfjs-dist/build/pdf.worker.mjs';
import {
  ensureText,
  LIMITS,
  ReviewError,
  utf8Size,
  type ParsedArtifact,
  type ReviewErrorCode,
  type TaskContext,
} from './types';
export const PDF_REVIEW_VERSION = 'pdfjs-6.3.289-review1';
interface ReviewReport {
  version: string;
  ok: boolean;
  reason: ReviewErrorCode | null;
  checked: number;
}
type ReviewedPDF = PDFDocumentProxy & {
  getWebchatReview?: (pageIndex?: number | null) => Promise<ReviewReport>;
};
const hasValues = (value: unknown): boolean =>
  value instanceof Map
    ? value.size > 0
    : !!value && typeof value === 'object' && Object.keys(value).length > 0;
export async function checkPdfReport(document: ReviewedPDF, pageIndex?: number): Promise<void> {
  if (version !== '6.3.289' || typeof document.getWebchatReview !== 'function')
    throw new ReviewError('document_unverifiable');
  const report = await document.getWebchatReview(pageIndex ?? null);
  if (report.version !== PDF_REVIEW_VERSION || !Number.isSafeInteger(report.checked))
    throw new ReviewError('document_unverifiable');
  if (!report.ok)
    throw new ReviewError(
      ['active_content_not_allowed', 'document_too_complex', 'encrypted_document'].includes(
        report.reason ?? '',
      )
        ? report.reason!
        : 'document_unverifiable',
    );
}
export async function parsePdf(bytes: Uint8Array, context: TaskContext): Promise<ParsedArtifact> {
  if (
    bytes.length < 8 ||
    new TextDecoder('ascii').decode(bytes.subarray(0, 8)).match(/^%PDF-[12]\.[0-9]/) === null
  )
    throw new ReviewError('file_type_mismatch');
  if (version !== '6.3.289') throw new ReviewError('document_unverifiable');
  const loading = getDocument({
    data: bytes.slice(),
    enableXfa: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    stopAtErrors: true,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  });
  let passwordRequested = false;
  const release = () => loading.destroy();
  context.resources.add(release);
  loading.onPassword = () => {
    passwordRequested = true;
    void loading.destroy();
  };
  try {
    const document = (await loading.promise) as ReviewedPDF;
    context.check();
    if (document.numPages > LIMITS.pdfPages) throw new ReviewError('document_too_many_pages');
    if (document.numPages < 1) throw new ReviewError('document_unverifiable');
    await checkPdfReport(document);
    const [attachments, actions, fields, metadata] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
      document.getFieldObjects(),
      document.getMetadata(),
    ]);
    if (
      hasValues(attachments) ||
      hasValues(actions) ||
      hasValues(fields) ||
      document.isPureXfa ||
      (metadata.info as Record<string, unknown>).IsXFAPresent
    )
      throw new ReviewError('active_content_not_allowed');
    // Exercise the public open-action API too; acceptance is decided from the raw patch above.
    await document.getOpenAction();
    let allItems = 0,
      weakPages = 0,
      textBytes = 0;
    const parts: string[] = [];
    const append = (text: string) => {
      textBytes += utf8Size(text);
      if (textBytes > LIMITS.text) throw new ReviewError('extracted_text_too_large');
      parts.push(text);
    };
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      context.check();
      context.pageStarted?.(pageNumber);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void loading.destroy();
      }, LIMITS.pdfPageMs);
      try {
        const page = await document.getPage(pageNumber);
        await checkPdfReport(document, pageNumber - 1);
        if (hasValues(await page.getJSActions()))
          throw new ReviewError('active_content_not_allowed');
        const annotations = await page.getAnnotations({ intent: 'any' });
        for (const annotation of annotations)
          if (
            annotation.subtype === 'Widget' ||
            annotation.file ||
            annotation.actions ||
            annotation.jsActions
          )
            throw new ReviewError('active_content_not_allowed');
        const reader = page
          .streamTextContent({ includeMarkedContent: false, disableNormalization: false })
          .getReader();
        let pageItems = 0,
          characters = 0;
        append(`\n[第 ${pageNumber} 页]\n`);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            context.check();
            if (timedOut) throw new ReviewError('document_parse_timeout');
            if (done) break;
            for (const item of value.items as { str?: string; hasEOL?: boolean }[]) {
              if (typeof item.str !== 'string') throw new ReviewError('document_unverifiable');
              if (++pageItems > LIMITS.pdfPageItems || ++allItems > LIMITS.pdfItems)
                throw new ReviewError('document_too_complex');
              for (const character of item.str) if (!/\s/u.test(character)) characters++;
              append(item.str + (item.hasEOL ? '\n' : ' '));
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          page.cleanup();
        }
        if (characters < 40) weakPages++;
        context.progress('parsing', pageNumber, document.numPages);
      } catch (error) {
        if (timedOut) throw new ReviewError('document_parse_timeout');
        throw error;
      } finally {
        clearTimeout(timer);
        context.pageFinished?.();
      }
    }
    if (weakPages === document.numPages || (weakPages > 2 && weakPages / document.numPages > 0.2))
      throw new ReviewError('document_requires_ocr');
    return {
      text: ensureText(parts.join('')),
      metrics: { pages: document.numPages, textItems: allItems, insufficientTextPages: weakPages },
      warnings: ['仅分析提取文字；图表、图片和部分排版未保留。请查看提取预览并确认。'],
    };
  } catch (error) {
    if (passwordRequested) throw new ReviewError('encrypted_document');
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('document_unverifiable');
  } finally {
    await release().catch(() => {});
    context.resources.delete(release);
  }
}
