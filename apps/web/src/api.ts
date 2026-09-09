import {
  ContractError,
  GATEWAY_URL_HEADER,
  isErrorCode,
  safeError,
  type ModelCapability,
  type PublicConfig,
  type SafeError,
} from '@chat/contracts';
export class ApiError extends Error {
  constructor(public readonly detail: SafeError) {
    super(detail.message);
  }
  get code() {
    return this.detail.code;
  }
}
export async function apiError(response: Response): Promise<ApiError> {
  let code: unknown,
    gatewayRequestId = response.headers.get('X-Gateway-Request-ID');
  const reader = response.body?.getReader();
  if (reader) {
    try {
      let size = 0,
        body = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      code = JSON.parse(body)?.error?.code;
    } catch {
      /* Fixed safe mapping below. */
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return new ApiError(
    safeError(
      isErrorCode(code)
        ? code
        : response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 429
              ? 'rate_limited'
              : 'upstream_error',
      response.headers.get('X-Webchat-Request-ID') ?? '',
      gatewayRequestId,
    ).error,
  );
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw await apiError(response);
  if (!response.body) throw new ContractError('invalid_request');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new ContractError('invalid_request');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function getConfig(): Promise<PublicConfig> {
  const value = (await readJson(
    await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) }),
  )) as PublicConfig;
  if (
    !value ||
    !Number.isInteger(value.schemaVersion) ||
    typeof value.policyVersion !== 'string' ||
    !value.features ||
    !value.policy
  )
    throw new ContractError('configuration_error');
  return value;
}
export async function getModels(key: string, gatewayUrl: string): Promise<ModelCapability[]> {
  const value = (await readJson(
    await fetch('/api/models', {
      headers: { Authorization: `Bearer ${key}`, [GATEWAY_URL_HEADER]: gatewayUrl },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    }),
  )) as { models: ModelCapability[] };
  if (
    !Array.isArray(value.models) ||
    !value.models.every((m) => typeof m.id === 'string' && typeof m.images === 'boolean')
  )
    throw new ContractError('invalid_request');
  return value.models;
}
