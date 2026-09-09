import { ContractError, normalizeGatewayUrl } from '@chat/contracts';

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

function privateHost(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    // Only global unicast IPv6 destinations; exclude mapped and local addresses.
    return !/^\[[23][0-9a-f]{3}:/.test(hostname);
  }
  if (/^[\d.]+$/.test(hostname)) {
    const [a, b] = hostname.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    !hostname.includes('.') || /\.(localhost|local|internal|lan|home|localdomain)$/.test(hostname)
  );
}

export function validateGatewayDestination(
  value: string,
  publicOrigin: string,
  allowLocal: boolean,
): string {
  const base = normalizeGatewayUrl(value),
    url = new URL(base),
    site = new URL(publicOrigin),
    hostname = url.hostname.replace(/\.$/, '');
  const local = allowLocal && loopback(hostname) && loopback(site.hostname);
  if (
    url.origin === site.origin ||
    (url.protocol !== 'https:' && !local) ||
    (privateHost(hostname) && !local)
  )
    throw new ContractError('invalid_gateway_url');
  return base;
}
