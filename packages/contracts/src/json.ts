import { ContractError } from './errors';

/** Scans bounded JSON before JSON.parse, rejecting escaped duplicate keys and depth excess. */
export function parseStrictJson(text: string, maxDepth = 16): unknown {
  let position = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[position] ?? '\0')) position++;
  };
  const fail = (): never => {
    throw new ContractError('invalid_json');
  };
  function string(): string {
    const start = position++;
    while (position < text.length) {
      const ch = text[position++];
      if (ch === '"') {
        try {
          return JSON.parse(text.slice(start, position)) as string;
        } catch {
          return fail();
        }
      }
      if (ch === '\\') position++;
      else if (ch !== undefined && ch.charCodeAt(0) < 32) fail();
    }
    return fail();
  }
  function value(depth: number): void {
    whitespace();
    const ch = text[position];
    if (ch === '{' || ch === '[') {
      if (depth + 1 > maxDepth) fail();
      const object = ch === '{';
      const end = object ? '}' : ']';
      const keys = object ? new Set<string>() : undefined;
      position++;
      whitespace();
      if (text[position] === end) {
        position++;
        return;
      }
      for (;;) {
        if (object) {
          if (text[position] !== '"') fail();
          const key = string();
          if (keys!.has(key)) fail();
          keys!.add(key);
          whitespace();
          if (text[position++] !== ':') fail();
        }
        value(depth + 1);
        whitespace();
        const separator = text[position++];
        if (separator === end) return;
        if (separator !== ',') fail();
        whitespace();
      }
    }
    if (ch === '"') {
      string();
      return;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(position),
    );
    if (!token) fail();
    position += token![0].length;
  }
  value(0);
  whitespace();
  if (position !== text.length) fail();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail();
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError('invalid_utf8');
  }
}
