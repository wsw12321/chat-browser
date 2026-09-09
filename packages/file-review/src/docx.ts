import { SaxesParser, type SaxesTagNS } from 'saxes';
import { inspectZip, inflateEntries, type ZipEntry } from './zip';
import {
  ensureText,
  LIMITS,
  ReviewError,
  utf8Size,
  type ParsedArtifact,
  type TaskContext,
} from './types';
const WORD = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const forbiddenWords = new Set([
  'sym',
  'vanish',
  'webHidden',
  'vMerge',
  'hMerge',
  'object',
  'altChunk',
  'txbxContent',
  'pict',
  'sdt',
  'fldSimple',
  'instrText',
  'ins',
  'del',
  'moveFrom',
  'moveTo',
  'moveFromRangeStart',
  'moveToRangeStart',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'customXml',
  'subDoc',
  'contentPart',
  'control',
]);
function attrs(tag: SaxesTagNS): Record<string, string> {
  const result: Record<string, string> = {};
  for (const a of Object.values(tag.attributes)) {
    if (a.uri && !WORD.has(a.uri)) continue;
    if (Object.prototype.hasOwnProperty.call(result, a.local))
      throw new ReviewError('document_unverifiable');
    result[a.local] = a.value;
  }
  return result;
}
const refuse = (): never => {
  throw new ReviewError('document_too_complex');
};
export function parseDocx(bytes: Uint8Array, context: TaskContext): ParsedArtifact {
  const entries = inspectZip(bytes),
    names = new Set(entries.map((e) => e.name));
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    if (!names.has(required)) throw new ReviewError('file_type_mismatch');
  let mediaBytes = 0;
  const media: string[] = [];
  for (const entry of entries) {
    if (
      /(?:^|\/)(?:vba[^/]*|activeX|embeddings|charts|diagrams|comments[^/]*|customXml)(?:\/|\.|$)/i.test(
        entry.name,
      )
    )
      throw new ReviewError('active_content_not_allowed');
    if (entry.name.startsWith('word/media/') && !entry.name.endsWith('/')) {
      media.push(entry.name);
      mediaBytes += entry.size;
      if (!/\.(png|jpe?g|gif|bmp|tiff?|webp|emf|wmf)$/i.test(entry.name)) refuse();
    }
  }
  if (media.length > LIMITS.mediaCount || mediaBytes > LIMITS.mediaBytes)
    throw new ReviewError('archive_expansion_limit');
  let events = 0,
    tables = 0,
    cells = 0,
    drawings = 0,
    textBytes = 0,
    mainType = false,
    officeRelationship = false;
  const textParts = new Map<string, string[]>(),
    relationships: { source: string; target: string; type: string; external: boolean }[] = [];
  let parser: SaxesParser<{ xmlns: true }> | undefined,
    decoder: TextDecoder | undefined,
    current: string | undefined,
    depth = 0,
    tableDepth = 0,
    insideText = 0,
    xmlPrefix = '',
    seenRoot = false,
    runDepth = 0,
    propertiesDepth = 0;
  const append = (part: string, text: string): void => {
    textBytes += utf8Size(text);
    if (textBytes > LIMITS.text) throw new ReviewError('extracted_text_too_large');
    textParts.get(part)!.push(text);
  };
  const count = (): void => {
    context.check();
    if (++events > LIMITS.xmlEvents) refuse();
  };
  const newParser = (entry: ZipEntry): void => {
    current = entry.name;
    depth = 0;
    tableDepth = 0;
    insideText = 0;
    xmlPrefix = '';
    seenRoot = false;
    runDepth = 0;
    propertiesDepth = 0;
    decoder = new TextDecoder('utf-8', { fatal: true });
    const extract = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(
      entry.name,
    );
    if (extract) textParts.set(entry.name, []);
    parser = new SaxesParser({ xmlns: true });
    parser.on('error', () => {
      throw new ReviewError('document_unverifiable');
    });
    parser.on('doctype', () => {
      throw new ReviewError('active_content_not_allowed');
    });
    parser.on('processinginstruction', () => {
      throw new ReviewError('active_content_not_allowed');
    });
    parser.on('xmldecl', (decl) => {
      if (decl.encoding && !/^utf-?8$/i.test(decl.encoding))
        throw new ReviewError('document_unverifiable');
    });
    parser.on('attribute', count);
    parser.on('opentag', (tag) => {
      count();
      if (++depth > LIMITS.xmlDepth) refuse();
      const a = attrs(tag);
      if (!seenRoot) {
        seenRoot = true;
        if (entry.name === '[Content_Types].xml' && (tag.local !== 'Types' || tag.uri !== CT))
          throw new ReviewError('file_type_mismatch');
        if (entry.name.endsWith('.rels') && (tag.local !== 'Relationships' || tag.uri !== REL))
          throw new ReviewError('document_unverifiable');
        if (extract && !WORD.has(tag.uri)) throw new ReviewError('document_unverifiable');
      }
      if (
        entry.name === '[Content_Types].xml' &&
        tag.uri === CT &&
        (tag.local === 'Override' || tag.local === 'Default')
      ) {
        const type = a.ContentType ?? '';
        if (
          /macroEnabled|vbaProject|oleObject|activeX|chart|diagram|comments|externalLink/i.test(
            type,
          )
        )
          throw new ReviewError('active_content_not_allowed');
        if (a.PartName === '/word/document.xml' && type === MAIN) mainType = true;
      }
      if (entry.name.endsWith('.rels') && tag.uri === REL && tag.local === 'Relationship') {
        if (!a.Type || !a.Target || !a.Id) throw new ReviewError('document_unverifiable');
        const external = a.TargetMode === 'External';
        if (a.TargetMode && a.TargetMode !== 'External' && a.TargetMode !== 'Internal')
          throw new ReviewError('document_unverifiable');
        if (
          /vbaProject|oleObject|package|attachedTemplate|aFChunk|activeX|chart|diagram|comments|customXml/i.test(
            a.Type,
          )
        )
          throw new ReviewError('active_content_not_allowed');
        if (external && !a.Type.endsWith('/hyperlink'))
          throw new ReviewError('active_content_not_allowed');
        relationships.push({ source: entry.name, target: a.Target, type: a.Type, external });
      }
      if (tag.local === 'AlternateContent' || tag.local === 'Choice' || tag.local === 'Fallback')
        refuse();
      if (tag.local === 'oMath' || tag.local === 'oMathPara' || tag.local === 'textbox') refuse();
      if (tag.local === 'graphicData' && a.uri && !/\/picture$/.test(a.uri)) refuse();
      if (WORD.has(tag.uri)) {
        if (tag.local === 'r') runDepth++;
        if (tag.local.endsWith('Pr')) propertiesDepth++;
        if (tag.local === 'gridSpan' && a.val !== '1') refuse();
        if (forbiddenWords.has(tag.local) || /PrChange$/.test(tag.local)) refuse();
        if (tag.local === 'tbl') {
          if (++tableDepth > 1 || ++tables > LIMITS.tables) refuse();
        }
        if (tag.local === 'tc' && ++cells > LIMITS.tableCells) refuse();
        if (extract) {
          if (tag.local === 't') insideText++;
          if (tag.local === 'tab' && runDepth > 0 && propertiesDepth === 0)
            append(entry.name, '\t');
          if (tag.local === 'br' || tag.local === 'cr') append(entry.name, '\n');
          if (tag.local === 'numPr') append(entry.name, '• ');
          if (tag.local === 'drawing') {
            drawings++;
            append(entry.name, '[图片未分析]');
          }
          if (tag.local === 'softHyphen') append(entry.name, '\u00ad');
          if (tag.local === 'noBreakHyphen') append(entry.name, '\u2011');
          if (tag.local === 'footnoteReference' || tag.local === 'endnoteReference')
            append(
              entry.name,
              `[${tag.local === 'footnoteReference' ? '脚注' : '尾注'} ${a.id ?? ''}]`,
            );
          if (tag.local === 'footnote' || tag.local === 'endnote')
            append(entry.name, `[${tag.local === 'footnote' ? '脚注' : '尾注'} ${a.id ?? ''}]\n`);
        }
      }
    });
    parser.on('closetag', (tag) => {
      count();
      depth--;
      if (WORD.has(tag.uri)) {
        if (tag.local === 'r') runDepth--;
        if (tag.local.endsWith('Pr')) propertiesDepth--;
        if (tag.local === 'tbl') tableDepth--;
        if (extract) {
          if (tag.local === 't') insideText--;
          if (tag.local === 'p') append(entry.name, '\n');
          if (tag.local === 'tc') append(entry.name, '\t');
          if (tag.local === 'tr') append(entry.name, '\n');
        }
      }
    });
    parser.on('text', (text) => {
      count();
      if (extract) {
        if (insideText) append(entry.name, text);
        else if (text.trim()) refuse();
      }
    });
    parser.on('cdata', (text) => {
      count();
      if (extract) {
        if (insideText) append(entry.name, text);
        else if (text.trim()) refuse();
      }
    });
    parser.on('comment', count);
  };
  let completed = 0,
    entryPrefix = new Uint8Array();
  inflateEntries(
    bytes,
    entries,
    (entry, chunk, final) => {
      if (current !== entry.name) {
        current = entry.name;
        entryPrefix = new Uint8Array();
        parser = undefined;
        decoder = undefined;
        if (/\.(xml|rels)$/i.test(entry.name)) newParser(entry);
      }
      if (entryPrefix.length < 4) {
        const merged = new Uint8Array(Math.min(4, entryPrefix.length + chunk.length));
        merged.set(entryPrefix);
        merged.set(chunk.subarray(0, merged.length - entryPrefix.length), entryPrefix.length);
        entryPrefix = merged;
        if (
          merged.length === 4 &&
          ((merged[0] === 0x50 && merged[1] === 0x4b && merged[2] === 3 && merged[3] === 4) ||
            (merged[0] === 0x1f && merged[1] === 0x8b && merged[2] === 8) ||
            (merged[0] === 0x37 &&
              merged[1] === 0x7a &&
              merged[2] === 0xbc &&
              merged[3] === 0xaf) ||
            (merged[0] === 0x52 &&
              merged[1] === 0x61 &&
              merged[2] === 0x72 &&
              merged[3] === 0x21) ||
            (merged[0] === 0xd0 && merged[1] === 0xcf && merged[2] === 0x11 && merged[3] === 0xe0))
        )
          throw new ReviewError('active_content_not_allowed');
      }
      if (parser && decoder) {
        let text: string;
        try {
          text = decoder.decode(chunk, { stream: !final });
        } catch {
          throw new ReviewError('document_unverifiable');
        }
        if (xmlPrefix.length < 200) {
          xmlPrefix += text.slice(0, 200 - xmlPrefix.length);
          if (/encoding\s*=\s*['"](?!utf-?8['"])/i.test(xmlPrefix))
            throw new ReviewError('document_unverifiable');
        }
        parser.write(text);
        if (final) parser.close();
      }
      if (final) context.progress('parsing', ++completed, entries.length);
    },
    () => context.check(),
  );
  if (drawings && !media.length) throw new ReviewError('document_unverifiable');
  if (!mainType) throw new ReviewError('file_type_mismatch');
  for (const relationship of relationships) {
    if (relationship.external) continue;
    if (/[\\\u0000-\u001f%]/.test(relationship.target))
      throw new ReviewError('document_unverifiable');
    const base =
      relationship.source === '_rels/.rels'
        ? ''
        : relationship.source.replace(/_rels\/[^/]+\.rels$/, '');
    const pieces = relationship.target.startsWith('/') ? [] : base.split('/').filter(Boolean);
    for (const piece of relationship.target.split('/')) {
      if (!piece || piece === '.') continue;
      if (piece === '..') {
        if (!pieces.length) throw new ReviewError('document_unverifiable');
        pieces.pop();
      } else pieces.push(piece);
    }
    const target = pieces.join('/').split('#')[0]!;
    if (!names.has(target)) throw new ReviewError('document_unverifiable');
    if (
      relationship.source === '_rels/.rels' &&
      [
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
        'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
      ].includes(relationship.type)
    ) {
      if (target !== 'word/document.xml') throw new ReviewError('file_type_mismatch');
      officeRelationship = true;
    }
  }
  if (!officeRelationship) throw new ReviewError('file_type_mismatch');
  const body = textParts.get('word/document.xml')?.join('') ?? '';
  const extras = [...textParts]
    .filter(([name]) => name !== 'word/document.xml')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, chunks]) =>
        `\n[${name.includes('header') ? '页眉' : name.includes('footer') ? '页脚' : name.includes('footnotes') ? '脚注' : '尾注'}：${name}]\n${chunks.join('')}`,
    );
  const text = ensureText(body + extras.join(''));
  return {
    text,
    metrics: {
      zipEntries: entries.length,
      xmlEvents: events,
      tables,
      tableCells: cells,
      images: media.length,
    },
    warnings: media.length
      ? [`图片未分析：${media.length} 张（${media.join('、')}）。请查看提取文字后确认。`]
      : [],
  };
}
