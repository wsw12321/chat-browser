import { ContractError } from './errors';

export const GATEWAY_URL_HEADER = 'X-Gateway-URL';

export function normalizeGatewayUrl(input: string): string {
  try {
    const value = input.trim();
    if (!value || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (
      !/^https?:\/\//i.test(value) ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      value.includes('?') ||
      value.includes('#')
    )
      throw new Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new ContractError('invalid_gateway_url');
  }
}

export function gatewayEndpoint(base: string, route: 'models' | 'responses'): string {
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/${route}`;
}
