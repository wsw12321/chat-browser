import {
  ContractError,
  isErrorCode,
  mappedGatewayError,
  safeError,
  type ErrorEnvelope,
  type SafeError,
} from './errors';
import { POLICY, utf8Bytes, type GenerationState } from './policy';
import { parseStrictJson } from './json';

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}
export interface SSELimits {
  maxBytes?: number;
  maxEventBytes?: number;
}
/** One event is retained at a time. Comments count toward byte limits. */
export class SSEParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private eventName = '';
  private data: string[] = [];
  private id: string | undefined;
  private total = 0;
  private eventSize = 0;
  private pendingCR = false;
  constructor(private readonly limits: SSELimits = {}) {}
  push(chunk: Uint8Array): SSEEvent[] {
    return [...this.iterate(chunk)];
  }
  *iterate(chunk: Uint8Array): Generator<SSEEvent> {
    this.total += chunk.byteLength;
    if (this.total > (this.limits.maxBytes ?? POLICY.response.bytes))
      throw new ContractError('response_too_large');
    try {
      yield* this.consume(this.decoder.decode(chunk, { stream: true }));
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError('stream_invalid');
    }
  }
  finish(): SSEEvent[] {
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch {
      throw new ContractError('stream_invalid');
    }
    // SSE requires a blank line to dispatch the final event; an unfinished frame is discarded.
    const events = [...this.consume(tail)];
    if (this.pendingCR) {
      this.pendingCR = false;
      const event = this.newline(1);
      if (event) events.push(event);
    }
    return events;
  }
  private *consume(text: string): Generator<SSEEvent> {
    for (let position = 0; position < text.length;) {
      if (this.pendingCR) {
        this.pendingCR = false;
        const crlf = text[position] === '\n';
        const event = this.newline(crlf ? 2 : 1);
        if (event) yield event;
        if (crlf) {
          position++;
          continue;
        }
      }
      let end = position;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
      const segment = text.slice(position, end);
      this.line += segment;
      this.eventSize += utf8Bytes(segment);
      if (this.eventSize > (this.limits.maxEventBytes ?? POLICY.response.eventBytes))
        throw new ContractError('response_too_large');
      if (end === text.length) break;
      if (text[end] === '\r') this.pendingCR = true;
      else {
        const event = this.newline(1);
        if (event) yield event;
      }
      position = end + 1;
    }
  }
  private newline(bytes: number): SSEEvent | null {
    this.eventSize += bytes;
    if (this.eventSize > (this.limits.maxEventBytes ?? POLICY.response.eventBytes))
      throw new ContractError('response_too_large');
    return this.processLine();
  }
  private processLine(): SSEEvent | null {
    const line = this.line;
    this.line = '';
    if (!line) {
      const event = this.data.length
        ? {
            event: this.eventName || 'message',
            data: this.data.join('\n'),
            ...(this.id === undefined ? {} : { id: this.id }),
          }
        : null;
      this.data = [];
      this.eventName = '';
      this.id = undefined;
      this.eventSize = 0;
      return event;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    return null;
  }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ContractError('stream_invalid');
  return value as RecordValue;
}
function parseEventData(data: string, maxDepth = 32): RecordValue {
  try {
    return record(parseStrictJson(data, maxDepth));
  } catch {
    throw new ContractError('stream_invalid');
  }
}
function index(value: unknown, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000)
    throw new ContractError('stream_invalid');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new ContractError('stream_invalid');
  return value;
}
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) ? value : undefined;
}
function diagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
function usage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    const number = (value as RecordValue)[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)
      result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}
export interface ResponseSnapshot {
  text: string;
  state: GenerationState;
  responseId?: string;
  usage?: Usage;
  error?: SafeError;
}
/** Tracks item/content indexes, treats final text as reconciliation rather than another delta. */
export class ResponseReconciler {
  private readonly parts = new Map<string, string>();
  private readonly partBytes = new Map<string, number>();
  private totalTextBytes = 0;
  private readonly finalized = new Set<string>();
  private readonly itemIndices = new Map<string, number>();
  private state: GenerationState = 'pending';
  private responseId: string | undefined;
  private finalUsage: Usage | undefined;
  private finalError: SafeError | undefined;
  constructor(private readonly maxTextBytes = POLICY.response.textBytes) {}
  get terminal(): boolean {
    return ['completed', 'failed', 'incomplete', 'interrupted', 'cancelled'].includes(this.state);
  }
  get snapshot(): ResponseSnapshot {
    return this.current(true);
  }
  private current(includeText: boolean): ResponseSnapshot {
    const text = includeText
      ? [...this.parts.entries()]
          .sort(([a], [b]) => {
            const aa = a.split(':').map(Number),
              bb = b.split(':').map(Number);
            return aa[0]! - bb[0]! || aa[1]! - bb[1]!;
          })
          .map(([, value]) => value)
          .join('')
      : '';
    return {
      text,
      state: this.state,
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.finalUsage ? { usage: this.finalUsage } : {}),
      ...(this.finalError ? { error: this.finalError } : {}),
    };
  }
  consume(event: SSEEvent, includeText = true): ResponseSnapshot {
    if (this.terminal) throw new ContractError('stream_invalid');
    if (event.event === 'webchat.error') {
      const value = parseEventData(event.data);
      const error = record(value.error);
      const code = isErrorCode(error.code) ? error.code : 'upstream_error';
      this.finalError = safeError(
        code,
        diagnosticId(error.requestId) ?? '',
        diagnosticId(error.gatewayRequestId) ?? null,
      ).error;
      this.state =
        code === 'interrupted'
          ? 'interrupted'
          : ['response_incomplete', 'response_too_large', 'unsupported_response_item'].includes(
                code,
              )
            ? 'incomplete'
            : 'failed';
      return this.current(includeText);
    }
    if (event.data === '[DONE]') throw new ContractError('stream_invalid');
    const value = parseEventData(event.data);
    const type = typeof value.type === 'string' ? value.type : event.event;
    if (event.event !== 'message' && event.event !== type)
      throw new ContractError('stream_invalid');
    if (value.item !== undefined) {
      const itemType = record(value.item).type;
      if (itemType !== 'message' && itemType !== 'reasoning')
        throw new ContractError('unsupported_response_item');
    }
    if (value.response !== undefined) {
      const response = record(value.response);
      if (response.output !== undefined) {
        if (!Array.isArray(response.output)) throw new ContractError('stream_invalid');
        for (const item of response.output) {
          const itemType = record(item).type;
          if (itemType !== 'message' && itemType !== 'reasoning')
            throw new ContractError('unsupported_response_item');
        }
      }
    }
    if (type === 'response.created' || type === 'response.in_progress') {
      this.state = 'streaming';
      if (value.response) this.responseId = identifier(record(value.response).id);
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(value.item);
      const output = index(value.output_index);
      this.acceptItem(item, output, type.endsWith('.done'));
    } else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      const part = record(value.part);
      const output = this.outputIndex(value);
      this.acceptPart(part, output, index(value.content_index), type.endsWith('.done'));
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      this.state = 'streaming';
      this.setPart(this.outputIndex(value), index(value.content_index), string(value.delta), false);
    } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      this.setPart(
        this.outputIndex(value),
        index(value.content_index),
        string(type === 'response.refusal.done' ? value.refusal : value.text),
        true,
      );
    } else if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) {
      const response = record(value.response);
      this.responseId = identifier(response.id) ?? this.responseId;
      if (response.status !== undefined && response.status !== type.slice('response.'.length))
        throw new ContractError('stream_invalid');
      if (response.output !== undefined) {
        if (!Array.isArray(response.output)) throw new ContractError('stream_invalid');
        const finalKeys = new Set<string>();
        for (const [output, itemValue] of response.output.entries()) {
          const item = record(itemValue);
          this.acceptItem(item, output, true);
          if (item.type === 'message' && Array.isArray(item.content))
            for (let content = 0; content < item.content.length; content++)
              finalKeys.add(`${output}:${content}`);
        }
        if (
          type === 'response.completed' &&
          [...this.parts.keys()].some((key) => !finalKeys.has(key))
        )
          throw new ContractError('stream_invalid');
      }
      if (type === 'response.completed' && response.output === undefined)
        throw new ContractError('stream_invalid');
      this.finalUsage = usage(response.usage);
      this.state =
        type === 'response.completed'
          ? 'completed'
          : type === 'response.failed'
            ? 'failed'
            : 'incomplete';
      if (this.state !== 'completed')
        this.finalError = safeError(
          this.state === 'failed' ? 'upstream_error' : 'response_incomplete',
        ).error;
    } else if (type === 'error') {
      this.state = 'failed';
      this.finalError = safeError('upstream_error').error;
    } else if (/^response\.(?:reasoning(?:_summary)?[._]|queued$)/.test(type)) {
      /* Public metadata carries no executable output. */
    } else if (
      /tool|function_call|computer|image_generation|file_search|web_search|code_interpreter|mcp|shell|apply_patch|audio|video/.test(
        type,
      )
    )
      throw new ContractError('unsupported_response_item');
    return this.current(includeText);
  }
  finish(): ResponseSnapshot {
    if (!this.terminal) {
      this.state = 'interrupted';
      this.finalError = safeError('interrupted').error;
    }
    return this.snapshot;
  }
  private outputIndex(value: RecordValue): number {
    const item = identifier(value.item_id);
    return index(value.output_index, item ? (this.itemIndices.get(item) ?? 0) : 0);
  }
  private acceptItem(item: RecordValue, output: number, final: boolean): void {
    const id = identifier(item.id);
    if (id) this.itemIndices.set(id, output);
    if (item.type === 'reasoning') return;
    if (item.type !== 'message' || (item.role !== undefined && item.role !== 'assistant'))
      throw new ContractError('unsupported_response_item');
    if (item.content !== undefined) {
      if (!Array.isArray(item.content)) throw new ContractError('stream_invalid');
      for (const [content, part] of item.content.entries())
        this.acceptPart(record(part), output, content, final);
    }
  }
  private acceptPart(part: RecordValue, output: number, content: number, final: boolean): void {
    if (part.type !== 'output_text' && part.type !== 'refusal')
      throw new ContractError('unsupported_response_item');
    const text = part.type === 'refusal' ? part.refusal : part.text;
    if (text !== undefined && (final || text !== ''))
      this.setPart(output, content, string(text), final);
  }
  private setPart(output: number, content: number, value: string, final: boolean): void {
    const key = `${output}:${content}`;
    const previous = this.parts.get(key) ?? '';
    if (this.finalized.has(key) && (!final || previous !== value))
      throw new ContractError('stream_invalid');
    if (final && !value.startsWith(previous)) throw new ContractError('stream_invalid');
    const next = final ? value : previous + value,
      oldBytes = this.partBytes.get(key) ?? 0,
      nextBytes = final ? utf8Bytes(value) : oldBytes + utf8Bytes(value);
    if (this.totalTextBytes - oldBytes + nextBytes > this.maxTextBytes)
      throw new ContractError('response_too_large');
    this.totalTextBytes += nextBytes - oldBytes;
    this.partBytes.set(key, nextBytes);
    this.parts.set(key, next);
    if (final) this.finalized.add(key);
  }
}

/** Strip arbitrary debug/error/metadata fields before forwarding an upstream event. */
export function sanitizedResponsesEvent(
  event: SSEEvent,
  snapshot: ResponseSnapshot,
  requestId: string,
  gatewayRequestId: string | null,
): SSEEvent | null {
  const source = parseEventData(event.data);
  const type = typeof source.type === 'string' ? source.type : event.event;
  if (['response.failed', 'response.incomplete', 'error'].includes(type)) {
    const upstreamError =
      type === 'response.failed' ? record(source.response).error : (source.error ?? source);
    return errorSSE(
      safeError(
        type === 'response.incomplete'
          ? 'response_incomplete'
          : mappedGatewayError(502, { error: upstreamError }),
        requestId,
        gatewayRequestId,
      ),
    );
  }
  const cleanPart = (value: unknown) => {
    const part = record(value);
    return part.type === 'refusal'
      ? { type: 'refusal', refusal: string(part.refusal ?? '') }
      : { type: 'output_text', text: string(part.text ?? '') };
  };
  const cleanItem = (value: unknown) => {
    const item = record(value);
    return item.type === 'reasoning'
      ? { type: 'reasoning' }
      : {
          type: 'message',
          id: identifier(item.id),
          role: 'assistant',
          content: Array.isArray(item.content) ? item.content.map(cleanPart) : [],
        };
  };
  if (type === 'response.completed') {
    const response = record(source.response);
    return {
      event: type,
      data: JSON.stringify({
        type,
        response: {
          id: snapshot.responseId,
          status: 'completed',
          output: Array.isArray(response.output) ? response.output.map(cleanItem) : [],
          usage: snapshot.usage,
        },
      }),
    };
  }
  if (type === 'response.created' || type === 'response.in_progress')
    return { event: type, data: JSON.stringify({ type, response: { id: snapshot.responseId } }) };
  // Preserve original indexes for per-part text reconciliation; item IDs are optional diagnostics.
  if (/^response\.(?:output_text|refusal)\.(?:delta|done)$/.test(type)) {
    const result: RecordValue = {
      type,
      output_index: source.output_index,
      content_index: source.content_index,
    };
    for (const key of ['delta', 'text', 'refusal'] as const)
      if (typeof source[key] === 'string') result[key] = source[key];
    const itemId = identifier(source.item_id);
    if (itemId) result.item_id = itemId;
    return { event: type, data: JSON.stringify(result) };
  }
  if (/^response\.output_item\.(?:added|done)$/.test(type))
    return {
      event: type,
      data: JSON.stringify({
        type,
        output_index: source.output_index,
        item: cleanItem(source.item),
      }),
    };
  if (/^response\.content_part\.(?:added|done)$/.test(type))
    return {
      event: type,
      data: JSON.stringify({
        type,
        output_index: source.output_index,
        content_index: source.content_index,
        item_id: identifier(source.item_id),
        part: cleanPart(source.part),
      }),
    };
  return null;
}
export function errorSSE(error: ErrorEnvelope): SSEEvent {
  return { event: 'webchat.error', data: JSON.stringify(error) };
}
export function encodeSSE(event: SSEEvent): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `event: ${event.event}\n${event.data
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n')}\n\n`,
  );
}
