import {
  APP_CONTRACT_VERSION,
  ContractError,
  POLICY,
  POLICY_VERSION,
  ResponseReconciler,
  SSEParser,
  decodeUtf8,
  encodeSSE,
  errorSSE,
  errorStatus,
  mappedGatewayError,
  normalizeError,
  parseStrictJson,
  rebuildGatewayRequest,
  safeError,
  sanitizedResponsesEvent,
  utf8Bytes,
  validateChatRequest,
  GATEWAY_URL_HEADER,
  gatewayEndpoint,
  type ErrorCode,
  type ModelCapability,
  type SSEEvent,
} from '@chat/contracts';
import { validateGatewayDestination } from './gateway';

export interface Env {
  PUBLIC_ORIGIN: string;
  GATEWAY_ORIGIN: string;
  MODEL_CAPABILITIES: string;
  POLICY_VERSION?: string;
  APP_CONTRACT_VERSION?: string;
  FEATURE_PDF?: string;
  FEATURE_DOCX?: string;
  FEATURE_IMAGES?: string;
  ALLOW_LOCAL_GATEWAY?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
type Timeouts = { [K in keyof typeof POLICY.timeouts]: number };
export interface WorkerOptions {
  fetch?: typeof fetch;
  timeouts?: Partial<Timeouts>;
}
const requestIdHeader = 'X-Webchat-Request-ID';
const gatewayIdHeader = 'X-Gateway-Request-ID';
const allowedGatewayId = (value: string | null): string | null =>
  value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;

function abortError(signal: AbortSignal, fallback: ErrorCode): ContractError {
  return new ContractError(signal.reason instanceof ContractError ? signal.reason.code : fallback);
}
async function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal, 'cancelled');
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal, 'cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutCode: ErrorCode = 'upload_timeout',
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const controller = new AbortController();
  const linked = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', linked, { once: true });
  if (signal?.aborted) linked();
  const timer = setTimeout(() => controller.abort(new ContractError(timeoutCode)), timeoutMs);
  let buffer = new Uint8Array(Math.min(64 * 1024, maxBytes));
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await raced(reader.read(), controller.signal);
      if (done) break;
      if (size + value.byteLength > maxBytes) throw new ContractError('request_too_large');
      if (size + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(size + value.byteLength, buffer.byteLength * 2)),
        );
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
    return buffer.subarray(0, size);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', linked);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function capabilities(env: Env): ModelCapability[] {
  let input: unknown;
  try {
    if (utf8Bytes(env.MODEL_CAPABILITIES ?? '') > 64 * 1024) throw new Error();
    input = parseStrictJson(env.MODEL_CAPABILITIES ?? '[]');
  } catch {
    throw new ContractError('configuration_error');
  }
  if (!Array.isArray(input) || input.length > 200) throw new ContractError('configuration_error');
  const ids = new Set<string>();
  return input.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).some((key) => key !== 'id' && key !== 'images') ||
      typeof value.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id) ||
      /codex-auto-review|internal|auto-review/i.test(value.id) ||
      typeof value.images !== 'boolean' ||
      ids.has(value.id)
    )
      throw new ContractError('configuration_error');
    ids.add(value.id);
    return { id: value.id, images: value.images && env.FEATURE_IMAGES === 'true' };
  });
}
function origins(env: Env): { gateway: string; publicOrigin: string } {
  try {
    const gateway = new URL(env.GATEWAY_ORIGIN),
      publicOrigin = new URL(env.PUBLIC_ORIGIN);
    const local =
      env.ALLOW_LOCAL_GATEWAY === 'true' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(publicOrigin.hostname);
    const protocols = local ? ['https:', 'http:'] : ['https:'];
    if (
      !protocols.includes(gateway.protocol) ||
      !protocols.includes(publicOrigin.protocol) ||
      gateway.username ||
      gateway.password ||
      gateway.pathname !== '/' ||
      gateway.search ||
      gateway.hash ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.pathname !== '/' ||
      publicOrigin.search ||
      publicOrigin.hash ||
      gateway.origin === publicOrigin.origin
    )
      throw new Error();
    return { gateway: gateway.origin, publicOrigin: publicOrigin.origin };
  } catch {
    throw new ContractError('configuration_error');
  }
}
function headers(
  requestId: string,
  gatewayId: string | null = null,
  contentType = 'application/json; charset=utf-8',
): Headers {
  const result = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    [requestIdHeader]: requestId,
  });
  if (gatewayId) result.set(gatewayIdHeader, gatewayId);
  return result;
}
function json(
  value: unknown,
  status: number,
  requestId: string,
  gatewayId: string | null = null,
): Response {
  return new Response(JSON.stringify(value), { status, headers: headers(requestId, gatewayId) });
}
function safeRetryAfter(value: string | null): string | null {
  return value && /^\d{1,5}$/.test(value) && Number(value) <= 86400 ? String(Number(value)) : null;
}

export function createWorker(options: WorkerOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const timeouts: Timeouts = { ...POLICY.timeouts, ...options.timeouts };
  let active = 0,
    parsing = 0;
  return {
    /** Diagnostic counts contain no user identifiers or content; useful for resource tests. */
    counts: () => ({ active, parsing }),
    async fetch(request: Request, env: Env): Promise<Response> {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api')
        return env.ASSETS
          ? env.ASSETS.fetch(request)
          : json(safeError('not_found', requestId), 404, requestId);
      let gatewayId: string | null = null,
        retryAfter: string | null = null,
        activeHeld = false,
        parsingHeld = false,
        handedOff = false;
      const upstreamController = new AbortController();
      const abortRequest = () => upstreamController.abort(new ContractError('cancelled'));
      request.signal.addEventListener('abort', abortRequest, { once: true });
      if (request.signal.aborted) abortRequest();
      const releaseActive = () => {
        if (activeHeld) {
          active--;
          activeHeld = false;
        }
        request.signal.removeEventListener('abort', abortRequest);
      };
      const releaseParsing = () => {
        if (parsingHeld) {
          parsing--;
          parsingHeld = false;
        }
      };
      try {
        const route = url.pathname;
        if (!['/api/config', '/api/models', '/api/chat'].includes(route))
          throw new ContractError('not_found');
        if (request.method !== (route === '/api/chat' ? 'POST' : 'GET'))
          throw new ContractError('method_not_allowed');
        const fixed = origins(env);
        if (
          Number(env.APP_CONTRACT_VERSION ?? APP_CONTRACT_VERSION) !== APP_CONTRACT_VERSION ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(env.POLICY_VERSION ?? POLICY_VERSION)
        )
          throw new ContractError('configuration_error');
        if (
          utf8Bytes([...request.headers].map(([key, value]) => `${key}:${value}`).join('\n')) >
          POLICY.request.headerBytes
        )
          throw new ContractError('invalid_request');
        if (
          (request.headers.has('Origin') && request.headers.get('Origin') !== fixed.publicOrigin) ||
          request.headers.get('Sec-Fetch-Site') === 'cross-site'
        )
          throw new ContractError('origin_denied');
        if (route === '/api/config')
          return json(
            {
              schemaVersion: Number(env.APP_CONTRACT_VERSION ?? APP_CONTRACT_VERSION),
              policyVersion: env.POLICY_VERSION ?? POLICY_VERSION,
              policy: POLICY,
              gatewayUrl: fixed.gateway,
              features: {
                pdf: env.FEATURE_PDF === 'true',
                docx: env.FEATURE_DOCX === 'true',
                images: env.FEATURE_IMAGES === 'true',
              },
            },
            200,
            requestId,
          );
        if (route === '/api/chat') {
          if (
            !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
              request.headers.get('Content-Type') ?? '',
            )
          )
            throw new ContractError('invalid_request');
          const encoding = request.headers.get('Content-Encoding');
          if (encoding && encoding.toLowerCase() !== 'identity')
            throw new ContractError('invalid_request');
          const length = request.headers.get('Content-Length');
          if (length !== null && !/^\d+$/.test(length)) throw new ContractError('invalid_request');
          if (length !== null && Number(length) > POLICY.request.bytes)
            throw new ContractError('request_too_large');
        }
        if (active >= POLICY.request.activePermits) throw new ContractError('edge_busy');
        active++;
        activeHeld = true;
        const authorization = request.headers.get('Authorization');
        if (!authorization || !/^Bearer [A-Za-z0-9._~+\/-]{8,512}$/.test(authorization))
          throw new ContractError('unauthorized');
        if (env.RATE_LIMITER) {
          const result = await env.RATE_LIMITER.limit({
            key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
          });
          if (!result.success) throw new ContractError('rate_limited');
        }
        const gateway = validateGatewayDestination(
          request.headers.get(GATEWAY_URL_HEADER) ?? fixed.gateway,
          fixed.publicOrigin,
          env.ALLOW_LOCAL_GATEWAY === 'true',
        );
        const accepted = capabilities(env);
        const call = async (
          route: 'models' | 'responses',
          init: RequestInit,
          timeoutMs: number,
        ): Promise<Response> => {
          const timer = setTimeout(
            () => upstreamController.abort(new ContractError('upstream_timeout')),
            timeoutMs,
          );
          try {
            const response = await raced(
              fetcher(gatewayEndpoint(gateway, route), {
                ...init,
                redirect: 'manual',
                signal: upstreamController.signal,
              }),
              upstreamController.signal,
            );
            gatewayId = allowedGatewayId(response.headers.get(gatewayIdHeader));
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              throw new ContractError('upstream_error');
            }
            if (!response.ok) {
              retryAfter = safeRetryAfter(response.headers.get('Retry-After'));
              let value: unknown;
              try {
                value = parseStrictJson(
                  decodeUtf8(
                    await readBounded(
                      response.body,
                      POLICY.request.errorResponseBytes,
                      timeouts.modelsMs,
                      upstreamController.signal,
                      'upstream_timeout',
                    ),
                  ),
                );
              } catch {
                /* Untrusted body is discarded. */
              }
              throw new ContractError(mappedGatewayError(response.status, value));
            }
            return response;
          } finally {
            clearTimeout(timer);
          }
        };
        const modelsStarted = Date.now();
        const modelsResponse = await call(
          'models',
          { headers: { Authorization: authorization, Accept: 'application/json' } },
          timeouts.modelsMs,
        );
        let modelsBody: unknown;
        try {
          modelsBody = parseStrictJson(
            decodeUtf8(
              await readBounded(
                modelsResponse.body,
                POLICY.request.modelResponseBytes,
                Math.max(1, timeouts.modelsMs - (Date.now() - modelsStarted)),
                upstreamController.signal,
                'upstream_timeout',
              ),
            ),
          );
        } catch (error) {
          if (error instanceof ContractError && error.code === 'upstream_timeout') throw error;
          throw new ContractError('upstream_error');
        }
        if (
          !modelsBody ||
          typeof modelsBody !== 'object' ||
          !('data' in modelsBody) ||
          !Array.isArray(modelsBody.data)
        )
          throw new ContractError('upstream_error');
        const allowedIds = new Set(
          modelsBody.data.flatMap((value: unknown) =>
            value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
              ? [value.id]
              : [],
          ),
        );
        const models = accepted.filter((model) => allowedIds.has(model.id));
        if (route === '/api/models') return json({ models }, 200, requestId, gatewayId);
        if (parsing >= POLICY.request.parsingPermits) throw new ContractError('edge_busy');
        parsing++;
        parsingHeld = true;
        // Parse and rebuild in a lexical scope; streaming closures retain only the serialized body until fetch completes.
        let body: string;
        {
          const bytes = await readBounded(
            request.body,
            POLICY.request.bytes,
            timeouts.uploadMs,
            upstreamController.signal,
          );
          const input = parseStrictJson(decodeUtf8(bytes), POLICY.request.depth);
          const validated = validateChatRequest(input, {
            models,
            policyVersion: env.POLICY_VERSION ?? POLICY_VERSION,
            schemaVersion: Number(env.APP_CONTRACT_VERSION ?? APP_CONTRACT_VERSION),
            images: env.FEATURE_IMAGES === 'true',
          });
          body = rebuildGatewayRequest(validated);
        }
        releaseParsing();
        const generationStarted = Date.now();
        const response = await call(
          'responses',
          {
            method: 'POST',
            headers: {
              Authorization: authorization,
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
            },
            body,
          },
          Math.min(timeouts.headersMs, timeouts.generationMs),
        );
        body = '';
        if (
          !/^text\/event-stream(?:;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new ContractError('upstream_error');
        }
        const stream = forwardStream(
          response.body,
          upstreamController,
          timeouts,
          Math.max(1, timeouts.generationMs - (Date.now() - generationStarted)),
          requestId,
          gatewayId,
          releaseActive,
        );
        handedOff = true;
        return new Response(stream, {
          headers: headers(requestId, gatewayId, 'text/event-stream; charset=utf-8'),
        });
      } catch (error) {
        const code = normalizeError(error);
        const result = json(
          safeError(code, requestId, gatewayId),
          errorStatus(code),
          requestId,
          gatewayId,
        );
        if (retryAfter) result.headers.set('Retry-After', retryAfter);
        return result;
      } finally {
        releaseParsing();
        if (!handedOff) {
          upstreamController.abort();
          releaseActive();
          if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
        }
      }
    },
  };
}

function forwardStream(
  body: ReadableStream<Uint8Array>,
  upstreamController: AbortController,
  timeouts: Timeouts,
  remainingMs: number,
  requestId: string,
  gatewayId: string | null,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader(),
    parser = new SSEParser(),
    reconciler = new ResponseReconciler();
  let upstreamByteCount = 0;
  let cancelled = false,
    closed = false,
    wake: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const totalTimer = setTimeout(
    () => upstreamController.abort(new ContractError('upstream_timeout')),
    remainingMs,
  );
  let idleTimer = setTimeout(
    () => upstreamController.abort(new ContractError('upstream_timeout')),
    timeouts.idleMs,
  );
  const upstreamBytesArrived = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => upstreamController.abort(new ContractError('upstream_timeout')),
      timeouts.idleMs,
    );
  };
  const onAbort = () => {
    wake?.();
    void reader.cancel().catch(() => {});
  };
  upstreamController.signal.addEventListener('abort', onAbort, { once: true });
  const clean = async () => {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    upstreamController.signal.removeEventListener('abort', onAbort);
    upstreamController.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    release();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = async (event: SSEEvent) => {
        while (
          !cancelled &&
          !upstreamController.signal.aborted &&
          (controller.desiredSize ?? 0) <= 0
        )
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (cancelled) return;
        if (upstreamController.signal.aborted)
          throw abortError(upstreamController.signal, 'cancelled');
        controller.enqueue(encodeSSE(event));
      };
      heartbeat = setInterval(() => {
        if (!closed && !cancelled && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
      }, timeouts.heartbeatMs);
      const consume = async (events: Iterable<SSEEvent>) => {
        for (const event of events) {
          const snapshot = reconciler.consume(event, false);
          const sanitized = sanitizedResponsesEvent(event, snapshot, requestId, gatewayId);
          if (sanitized) await emit(sanitized);
          if (reconciler.terminal) return;
        }
      };
      void (async () => {
        try {
          for (;;) {
            const result = await raced(reader.read(), upstreamController.signal);
            if (result.done) await consume(parser.finish());
            else {
              upstreamByteCount += result.value.byteLength;
              if (upstreamByteCount > POLICY.response.bytes)
                throw new ContractError('response_too_large');
              if (result.value.byteLength) upstreamBytesArrived();
              for (
                let offset = 0;
                offset < result.value.byteLength && !reconciler.terminal;
                offset += 16 * 1024
              )
                await consume(parser.iterate(result.value.subarray(offset, offset + 16 * 1024)));
            }
            if (reconciler.terminal) break;
            if (result.done) {
              await emit(errorSSE(safeError('interrupted', requestId, gatewayId)));
              break;
            }
          }
        } catch (error) {
          if (!cancelled)
            controller.enqueue(
              encodeSSE(errorSSE(safeError(normalizeError(error), requestId, gatewayId))),
            );
        } finally {
          closed = true;
          if (!cancelled) controller.close();
          await clean();
        }
      })();
    },
    pull() {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    },
    async cancel() {
      cancelled = true;
      wake?.();
      upstreamController.abort(new ContractError('cancelled'));
      await reader.cancel().catch(() => {});
    },
  });
}

export default createWorker();
