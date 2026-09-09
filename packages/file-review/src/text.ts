import Papa from 'papaparse';
import {
  ensureText,
  LIMITS,
  ReviewError,
  utf8Size,
  type Format,
  type ParsedArtifact,
} from './types';
export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReviewError('document_parse_failed');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new ReviewError('document_parse_failed');
  return text.replace(/\r\n?/g, '\n');
}
export function checkJson(text: string): void {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > LIMITS.jsonDepth) throw new ReviewError('document_too_complex');
    } else if (char === '}' || char === ']') depth--;
  }
  try {
    JSON.parse(text);
  } catch {
    throw new ReviewError('document_parse_failed');
  }
}
/** Bound decoded field bytes before PapaParse can collect a complete giant row.
 * PapaParse remains the authority for quoting/escaping and syntax validity. */
function precheckCsvFields(text: string): void {
  let quoted = false,
    atStart = true,
    fieldBytes = 0,
    columns = 1;
  const add = (codePoint: number) => {
    fieldBytes += codePoint < 128 ? 1 : codePoint < 2048 ? 2 : codePoint < 65536 ? 3 : 4;
    if (fieldBytes > LIMITS.csvCellBytes) throw new ReviewError('document_too_complex');
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index)!,
      character = String.fromCodePoint(code);
    if (code > 65535) index++;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          add(34);
          index++;
        } else quoted = false;
      } else add(code);
    } else if (character === ',' || character === '\n') {
      fieldBytes = 0;
      atStart = true;
      if (character === ',') {
        if (++columns > LIMITS.csvColumns) throw new ReviewError('document_too_complex');
      } else columns = 1;
    } else if (character === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else {
      add(code);
      atStart = false;
    }
  }
}
export function parseText(bytes: Uint8Array, format: Format): ParsedArtifact {
  const text = decodeUtf8(bytes);
  const metrics: Record<string, number> = {};
  if (format === 'json') checkJson(text);
  if (format === 'csv') {
    precheckCsvFields(text);
    let rows = 0,
      nonempty = 0,
      columns = 0;
    Papa.parse<string[]>(text, {
      delimiter: ',',
      skipEmptyLines: true,
      dynamicTyping: false,
      step(result, parser) {
        if (result.errors.length) {
          parser.abort();
          throw new ReviewError('document_parse_failed');
        }
        rows++;
        columns = Math.max(columns, result.data.length);
        for (const cell of result.data) {
          if (utf8Size(cell) > LIMITS.csvCellBytes) {
            parser.abort();
            throw new ReviewError('document_too_complex');
          }
          if (cell.length) nonempty++;
        }
        if (rows > LIMITS.csvRows || columns > LIMITS.csvColumns || nonempty > LIMITS.csvCells) {
          parser.abort();
          throw new ReviewError('document_too_complex');
        }
      },
    });
    Object.assign(metrics, { rows, columns, nonemptyCells: nonempty });
  }
  return { text: ensureText(text), metrics, warnings: [] };
}
