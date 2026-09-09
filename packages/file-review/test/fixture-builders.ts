import { zipSync, strToU8 } from 'fflate';
export const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export function docx(
  body = '<w:p><w:r><w:t>Hello plain document.</w:t></w:r></w:p>',
  parts: Record<string, string | Uint8Array> = {},
  level: 0 | 1 | 6 = 0,
): Uint8Array {
  const content: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`,
    ),
  };
  for (const [name, value] of Object.entries(parts))
    content[name] = typeof value === 'string' ? strToU8(value) : value;
  return zipSync(content, { level });
}
export interface PDFOptions {
  pages?: number;
  text?: string;
  catalog?: string;
  page?: string;
  objects?: string[];
  trailer?: string;
  brokenXref?: boolean;
}
/** Small, standards-shaped PDF with exact byte offsets, never production or user data. */
export function pdf(options: PDFOptions = {}): Uint8Array {
  const count = options.pages ?? 1,
    text =
      options.text ??
      'This ordinary document has enough extractable characters for reliable text review.';
  const objects: string[] = [`<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`, ''];
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (let p = 0; p < count; p++) {
    const pageId = objects.length + 1,
      streamId = pageId + 1;
    pageIds.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R ${options.page ?? ''} >>`,
    );
    const stream = `BT /F1 12 Tf 40 750 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects.push(
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects.push(...(options.objects ?? []));
  let result = '%PDF-1.7\n',
    offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(new TextEncoder().encode(result).length);
    result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(result).length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${options.trailer ?? ''} >>\nstartxref\n${options.brokenXref ? 1 : xref}\n%%EOF\n`;
  return new TextEncoder().encode(result);
}
