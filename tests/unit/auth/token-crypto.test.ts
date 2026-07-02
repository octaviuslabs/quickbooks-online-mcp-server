/**
 * Tests for the stateless sealed-token primitives used by the HTTP OAuth
 * proxy. Everything the proxy hands to MCP clients (client IDs, authorization
 * codes, access/refresh tokens) is one of these sealed blobs, so tamper
 * resistance and purpose binding are load-bearing security properties.
 */
import crypto from 'node:crypto';
import { seal, unseal, resolveTokenEncryptionKey, TokenSealError } from '../../../src/auth/token-crypto';

const key = crypto.randomBytes(32);

describe('seal/unseal', () => {
  it('round-trips a payload for each purpose', () => {
    const payload = { realm: '12345', nested: { list: [1, 2, 3] } };
    for (const purpose of ['client', 'state', 'code', 'access', 'refresh'] as const) {
      const token = seal(payload, key, purpose);
      expect(token.startsWith('v1.')).toBe(true);
      expect(unseal(token, key, purpose)).toEqual(payload);
    }
  });

  it('produces different ciphertexts for identical payloads (random IV)', () => {
    const a = seal({ x: 1 }, key, 'access');
    const b = seal({ x: 1 }, key, 'access');
    expect(a).not.toEqual(b);
  });

  it('rejects a token sealed for a different purpose', () => {
    const token = seal({ x: 1 }, key, 'client');
    expect(() => unseal(token, key, 'access')).toThrow(TokenSealError);
  });

  it('rejects a token sealed with a different key', () => {
    const token = seal({ x: 1 }, key, 'access');
    expect(() => unseal(token, crypto.randomBytes(32), 'access')).toThrow(TokenSealError);
  });

  it('rejects a tampered token', () => {
    const token = seal({ x: 1 }, key, 'access');
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(() => unseal(flipped, key, 'access')).toThrow(TokenSealError);
  });

  it('rejects tokens without the version prefix', () => {
    expect(() => unseal('no-dot-here', key, 'access')).toThrow('Unrecognized token format');
    expect(() => unseal('v2.abcdef', key, 'access')).toThrow('Unrecognized token format');
  });

  it('rejects tokens too short to contain an IV and auth tag', () => {
    expect(() => unseal('v1.aGVsbG8', key, 'access')).toThrow('Token is too short');
  });
});

describe('resolveTokenEncryptionKey', () => {
  it('accepts a 64-char hex key', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    expect(resolveTokenEncryptionKey(hex, 'secret')).toEqual(Buffer.from(hex, 'hex'));
  });

  it('accepts a base64-encoded 32-byte key', () => {
    const raw = crypto.randomBytes(32);
    expect(resolveTokenEncryptionKey(raw.toString('base64'), 'secret')).toEqual(raw);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => resolveTokenEncryptionKey('too-short', 'secret')).toThrow(TokenSealError);
  });

  it('derives a deterministic key from the client secret when no key is set', () => {
    const a = resolveTokenEncryptionKey(undefined, 'client-secret');
    const b = resolveTokenEncryptionKey(undefined, 'client-secret');
    const c = resolveTokenEncryptionKey(undefined, 'other-secret');
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(c);
  });
});
