import { describe, expect, it } from 'vitest';
import { gatewayEndpoint, normalizeGatewayUrl } from './gateway';

describe('Gateway URL input', () => {
  it.each([
    [' https://GATEWAY.example.com/ ', 'https://gateway.example.com'],
    ['https://gateway.example.com/v1/', 'https://gateway.example.com/v1'],
    ['https://gateway.example.com/proxy/', 'https://gateway.example.com/proxy'],
    ['http://127.0.0.1:8790/', 'http://127.0.0.1:8790'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGatewayUrl(input)).toBe(expected);
  });

  it.each([
    '',
    '/api',
    'gateway.example.com',
    'https:gateway.example.com',
    'ftp://gateway.example.com',
    'https://user:key@gateway.example.com',
    'https://gateway.example.com/?key=secret',
    'https://gateway.example.com/#fragment',
    'https://gate\nway.example.com',
    'https://gateway.example.com\\proxy',
  ])('rejects malformed or credential-bearing URL %s', (input) => {
    expect(() => normalizeGatewayUrl(input)).toThrow(
      expect.objectContaining({ code: 'invalid_gateway_url' }),
    );
  });

  it('preserves proxy paths without duplicating v1', () => {
    expect(gatewayEndpoint('https://gateway.example.com', 'models')).toBe(
      'https://gateway.example.com/v1/models',
    );
    expect(gatewayEndpoint('https://gateway.example.com/proxy/v1', 'responses')).toBe(
      'https://gateway.example.com/proxy/v1/responses',
    );
    expect(gatewayEndpoint('https://gateway.example.com/proxy', 'models')).toBe(
      'https://gateway.example.com/proxy/v1/models',
    );
  });
});
