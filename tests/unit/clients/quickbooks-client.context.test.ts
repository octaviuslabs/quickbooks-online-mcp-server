/**
 * Tests for the per-request credential path used by the stateless HTTP
 * transport: when a request runs inside quickbooksRequestContext, the
 * QuickbooksClient statics must build clients from the request's own Intuit
 * token instead of touching the env-based singleton's token lifecycle.
 */
import { jest } from '@jest/globals';

process.env.QUICKBOOKS_CLIENT_ID = 'test-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-client-secret';
process.env.QUICKBOOKS_REFRESH_TOKEN = 'env-refresh-token';
process.env.QUICKBOOKS_REALM_ID = '11111';
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
process.env.QUICKBOOKS_REDIRECT_URI = 'http://localhost:8000/callback';

// Record every QuickBooks construction so tests can assert which credentials
// were used, without hitting the network.
const qbConstructions: unknown[][] = [];
jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    constructor(...args: unknown[]) {
      qbConstructions.push(args);
    }
  },
}));

const refreshUsingTokenMock = jest.fn<() => Promise<unknown>>(() => {
  throw new Error('singleton refresh must not run for context-scoped requests');
});
jest.unstable_mockModule('intuit-oauth', () => ({
  default: class MockOAuthClient {
    static scopes: Record<string, string> = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = refreshUsingTokenMock;
    constructor(_cfg: Record<string, unknown>) {}
  },
}));

jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));
jest.unstable_mockModule('http', () => ({ default: { createServer: jest.fn() } }));
jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: jest.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    existsSync: jest.fn(() => false),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
  },
}));

const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client');
const { quickbooksRequestContext } = await import('../../../src/clients/request-context');

const requestCtx = { accessToken: 'per-request-access-token', realmId: '99999' };

describe('QuickbooksClient with a request context', () => {
  it('getInstance() builds a client from the request credentials without refreshing the singleton', async () => {
    const instance = await quickbooksRequestContext.run(requestCtx, () => QuickbooksClient.getInstance());

    expect(instance).toBeDefined();
    expect(qbConstructions).toHaveLength(1);
    const [clientId, clientSecret, accessToken, tokenSecret, realmId, useSandbox] = qbConstructions[0];
    expect(clientId).toBe('test-client-id');
    expect(clientSecret).toBe('test-client-secret');
    expect(accessToken).toBe('per-request-access-token');
    expect(tokenSecret).toBe(false);
    expect(realmId).toBe('99999');
    expect(useSandbox).toBe(true);
    expect(refreshUsingTokenMock).not.toHaveBeenCalled();
  });

  it('getInstance() builds a fresh instance per call (no cross-request sharing)', async () => {
    const first = await quickbooksRequestContext.run(requestCtx, () => QuickbooksClient.getInstance());
    const second = await quickbooksRequestContext.run({ accessToken: 'other-token', realmId: '22222' }, () =>
      QuickbooksClient.getInstance()
    );

    expect(first).not.toBe(second);
    const lastArgs = qbConstructions.at(-1)!;
    expect(lastArgs[2]).toBe('other-token');
    expect(lastArgs[4]).toBe('22222');
  });

  it('getAuthCredentials() returns the request credentials', async () => {
    const creds = await quickbooksRequestContext.run(requestCtx, () => QuickbooksClient.getAuthCredentials());
    expect(creds).toEqual({ accessToken: 'per-request-access-token', realmId: '99999', isSandbox: true });
    expect(refreshUsingTokenMock).not.toHaveBeenCalled();
  });
});
