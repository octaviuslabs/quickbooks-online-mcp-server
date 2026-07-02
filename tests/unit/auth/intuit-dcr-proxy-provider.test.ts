/**
 * Tests for the stateless DCR proxy that fronts Intuit's OAuth service.
 *
 * The provider is exercised the way the MCP SDK's auth router drives it:
 * register -> authorize (redirect to Intuit) -> Intuit callback -> code
 * exchange -> bearer verification -> refresh -> revoke. Intuit itself is
 * replaced by a mocked global fetch.
 */
import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { IntuitDcrProxyProvider, INTUIT_ACCOUNTING_SCOPE } from '../../../src/auth/intuit-dcr-proxy-provider';
import { seal, unseal } from '../../../src/auth/token-crypto';

const tokenKey = crypto.randomBytes(32);
const baseUrl = new URL('https://qbo-mcp.example.com');

const makeProvider = (scope?: string) =>
  new IntuitDcrProxyProvider({
    clientId: 'intuit-app-id',
    clientSecret: 'intuit-app-secret',
    baseUrl,
    tokenKey,
    ...(scope ? { scope } : {}),
  });

const fetchMock = jest.fn<typeof fetch>();
beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

const jsonResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as globalThis.Response;

const makeResponse = () => {
  const res = {
    redirect: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { redirect: jest.Mock; status: jest.Mock; send: jest.Mock };
};

/** Runs DCR the way the SDK's /register handler does. */
const registerClient = (provider: IntuitDcrProxyProvider, overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull => {
  const store = provider.clientsStore;
  return store.registerClient!({
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret: 'generated-secret',
    redirect_uris: ['https://client.example.com/oauth/callback'],
    client_name: 'Test MCP Client',
    ...overrides,
  } as OAuthClientInformationFull) as OAuthClientInformationFull;
};

/** Drives authorize + Intuit callback, returning the code sent to the client. */
const completeAuthorization = async (
  provider: IntuitDcrProxyProvider,
  client: OAuthClientInformationFull,
  { state, codeChallenge = 'challenge-abc' }: { state?: string; codeChallenge?: string } = {}
): Promise<{ code: string; redirect: URL }> => {
  const authorizeRes = makeResponse();
  await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge, state }, authorizeRes);
  const intuitUrl = new URL(authorizeRes.redirect.mock.calls[0][1] as string);

  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { access_token: 'intuit-access', refresh_token: 'intuit-refresh', expires_in: 3600 })
  );
  const callbackRes = makeResponse();
  await provider.handleIntuitCallback(
    { query: { code: 'intuit-code', state: intuitUrl.searchParams.get('state'), realmId: '9130350000000' } } as unknown as Request,
    callbackRes
  );
  const redirect = new URL(callbackRes.redirect.mock.calls[0][1] as string);
  return { code: redirect.searchParams.get('code')!, redirect };
};

describe('clientsStore (stateless DCR)', () => {
  it('mints a client_id that fully reconstructs the registration', () => {
    const provider = makeProvider();
    const registered = registerClient(makeProvider());
    const fetched = provider.clientsStore.getClient(registered.client_id) as OAuthClientInformationFull;

    expect(fetched.redirect_uris).toEqual(['https://client.example.com/oauth/callback']);
    expect(fetched.client_secret).toBe('generated-secret');
    expect(fetched.client_secret_expires_at).toBe(0);
    expect(fetched.client_name).toBe('Test MCP Client');
    expect(fetched.scope).toBe(INTUIT_ACCOUNTING_SCOPE);
    expect(fetched.token_endpoint_auth_method).toBe('client_secret_post');
    expect(fetched.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('supports public clients (no secret)', () => {
    const provider = makeProvider();
    const registered = registerClient(provider, { client_secret: undefined });
    expect(registered.client_secret_expires_at).toBeUndefined();

    const fetched = provider.clientsStore.getClient(registered.client_id) as OAuthClientInformationFull;
    expect(fetched.client_secret).toBeUndefined();
    expect(fetched.client_secret_expires_at).toBeUndefined();
    expect(fetched.token_endpoint_auth_method).toBe('none');
  });

  it('preserves an explicitly requested scope', () => {
    const provider = makeProvider();
    const registered = registerClient(provider, { scope: 'custom.scope' });
    expect(registered.scope).toBe('custom.scope');
    expect((provider.clientsStore.getClient(registered.client_id) as OAuthClientInformationFull).scope).toBe('custom.scope');
  });

  it('returns undefined for client_ids it did not mint', () => {
    const provider = makeProvider();
    expect(provider.clientsStore.getClient('not-a-sealed-id')).toBeUndefined();
    expect(provider.clientsStore.getClient(seal({ fake: true }, tokenKey, 'access'))).toBeUndefined();
  });
});

describe('authorize', () => {
  it("redirects to Intuit with the proxy's credentials and a sealed state", async () => {
    const provider = makeProvider();
    const client = registerClient(provider);
    const res = makeResponse();

    await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'pkce-challenge', state: 'client-state' }, res);

    const [status, location] = res.redirect.mock.calls[0];
    expect(status).toBe(302);
    const url = new URL(location as string);
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('intuit-app-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(INTUIT_ACCOUNTING_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe('https://qbo-mcp.example.com/callback');

    const state = unseal<{ h: string; u: string; c: string; t?: string }>(url.searchParams.get('state')!, tokenKey, 'state');
    expect(state.u).toBe(client.redirect_uris[0]);
    expect(state.c).toBe('pkce-challenge');
    expect(state.t).toBe('client-state');
  });

  it('honors a custom scope', async () => {
    const provider = makeProvider('custom.scope');
    const client = registerClient(provider);
    const res = makeResponse();
    await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'c' }, res);
    expect(new URL(res.redirect.mock.calls[0][1] as string).searchParams.get('scope')).toBe('custom.scope');
  });
});

describe('handleIntuitCallback', () => {
  const provider = makeProvider();

  it('responds 400 when state is missing or unsealable', async () => {
    for (const query of [{}, { state: 'garbage', code: 'x', realmId: '1' }]) {
      const res = makeResponse();
      await provider.handleIntuitCallback({ query } as unknown as Request, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('relays an Intuit error to the client redirect URI along with its state', async () => {
    const client = registerClient(provider);
    const authorizeRes = makeResponse();
    await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'c', state: 'abc' }, authorizeRes);
    const state = new URL(authorizeRes.redirect.mock.calls[0][1] as string).searchParams.get('state')!;

    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, error: 'access_denied', error_description: 'user said no' } } as unknown as Request, res);
    const redirect = new URL(res.redirect.mock.calls[0][1] as string);
    expect(redirect.origin).toBe('https://client.example.com');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('error_description')).toBe('user said no');
    expect(redirect.searchParams.get('state')).toBe('abc');
  });

  it('uses a default error description when Intuit provides none', async () => {
    const state = seal({ h: 'h', u: 'https://client.example.com/cb', c: 'c', iat: Math.floor(Date.now() / 1000) }, tokenKey, 'state');
    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, error: 'access_denied' } } as unknown as Request, res);
    const redirect = new URL(res.redirect.mock.calls[0][1] as string);
    expect(redirect.searchParams.get('error_description')).toBe('Authorization with Intuit failed');
    expect(redirect.searchParams.has('state')).toBe(false);
  });

  it('rejects stale authorization state', async () => {
    const state = seal({ h: 'h', u: 'https://client.example.com/cb', c: 'c', iat: Math.floor(Date.now() / 1000) - 3600 }, tokenKey, 'state');
    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, code: 'x', realmId: '1' } } as unknown as Request, res);
    expect(new URL(res.redirect.mock.calls[0][1] as string).searchParams.get('error')).toBe('access_denied');
  });

  it('rejects callbacks missing code or realmId', async () => {
    const state = seal({ h: 'h', u: 'https://client.example.com/cb', c: 'c', iat: Math.floor(Date.now() / 1000) }, tokenKey, 'state');
    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, code: 'x' } } as unknown as Request, res);
    expect(new URL(res.redirect.mock.calls[0][1] as string).searchParams.get('error')).toBe('invalid_request');
  });

  it('redirects with server_error when the Intuit code exchange fails', async () => {
    const state = seal({ h: 'h', u: 'https://client.example.com/cb', c: 'c', iat: Math.floor(Date.now() / 1000) }, tokenKey, 'state');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, code: 'bad', realmId: '1' } } as unknown as Request, res);
    expect(new URL(res.redirect.mock.calls[0][1] as string).searchParams.get('error')).toBe('server_error');
  });

  it('still reports server_error when the Intuit error body is unreadable', async () => {
    const state = seal({ h: 'h', u: 'https://client.example.com/cb', c: 'c', iat: Math.floor(Date.now() / 1000) }, tokenKey, 'state');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => {
        throw new Error('connection reset');
      },
    } as unknown as globalThis.Response);
    const res = makeResponse();
    await provider.handleIntuitCallback({ query: { state, code: 'bad', realmId: '1' } } as unknown as Request, res);
    expect(new URL(res.redirect.mock.calls[0][1] as string).searchParams.get('error')).toBe('server_error');
  });

  it('exchanges the Intuit code immediately and forwards a sealed code to the client', async () => {
    const client = registerClient(provider);
    const { code, redirect } = await completeAuthorization(provider, client, { state: 'client-state' });

    expect(redirect.origin).toBe('https://client.example.com');
    expect(redirect.searchParams.get('state')).toBe('client-state');

    // The Intuit exchange used the proxy's callback as redirect_uri
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('intuit-code');
    expect(body.get('redirect_uri')).toBe('https://qbo-mcp.example.com/callback');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('intuit-app-id:intuit-app-secret').toString('base64')}`
    );

    const sealedCode = unseal<{ at: string; rt: string; r: string; c: string }>(code, tokenKey, 'code');
    expect(sealedCode).toMatchObject({ at: 'intuit-access', rt: 'intuit-refresh', r: '9130350000000', c: 'challenge-abc' });
  });
});

describe('token exchange', () => {
  const provider = makeProvider();

  it('returns the PKCE challenge stored in the code', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client, { codeChallenge: 'the-challenge' });
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe('the-challenge');
  });

  it('rejects garbage authorization codes', async () => {
    const client = registerClient(provider);
    await expect(provider.exchangeAuthorizationCode(client, 'garbage')).rejects.toThrow(InvalidGrantError);
  });

  it('rejects codes issued to a different client', async () => {
    const clientA = registerClient(provider);
    const clientB = registerClient(provider, { redirect_uris: ['https://other.example.com/cb'] });
    const { code } = await completeAuthorization(provider, clientA);
    await expect(provider.exchangeAuthorizationCode(clientB, code)).rejects.toThrow('different client');
  });

  it('rejects expired codes', async () => {
    const client = registerClient(provider);
    const code = seal(
      {
        h: crypto.createHash('sha256').update(client.client_id).digest('base64url'),
        u: client.redirect_uris[0],
        c: 'c',
        at: 'a',
        rt: 'r',
        ax: Math.floor(Date.now() / 1000) + 3600,
        r: '1',
        iat: Math.floor(Date.now() / 1000) - 3600,
      },
      tokenKey,
      'code'
    );
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow('expired');
  });

  it('rejects a mismatched redirect_uri', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client);
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example.com/cb')).rejects.toThrow('redirect_uri');
  });

  it('mints sealed access/refresh tokens wrapping the Intuit tokens', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    expect(tokens.token_type).toBe('bearer');
    expect(tokens.scope).toBe(INTUIT_ACCOUNTING_SCOPE);
    expect(tokens.expires_in).toBeGreaterThan(3500);

    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth.extra).toEqual({ accessToken: 'intuit-access', realmId: '9130350000000' });
    expect(auth.scopes).toEqual([INTUIT_ACCOUNTING_SCOPE]);
    expect(auth.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const refresh = unseal<{ rt: string; r: string }>(tokens.refresh_token!, tokenKey, 'refresh');
    expect(refresh).toMatchObject({ rt: 'intuit-refresh', r: '9130350000000' });
  });
});

describe('exchangeRefreshToken', () => {
  const provider = makeProvider();

  it('rejects garbage refresh tokens', async () => {
    const client = registerClient(provider);
    await expect(provider.exchangeRefreshToken(client, 'garbage')).rejects.toThrow(InvalidGrantError);
  });

  it('rejects refresh tokens issued to a different client', async () => {
    const clientA = registerClient(provider);
    const clientB = registerClient(provider, { redirect_uris: ['https://other.example.com/cb'] });
    const { code } = await completeAuthorization(provider, clientA);
    const tokens = await provider.exchangeAuthorizationCode(clientA, code);
    await expect(provider.exchangeRefreshToken(clientB, tokens.refresh_token!)).rejects.toThrow('different client');
  });

  it('surfaces an Intuit refusal as invalid_grant so clients re-authorize', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(InvalidGrantError);
  });

  it('wraps non-Error transport failures in invalid_grant', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    fetchMock.mockRejectedValueOnce('socket hang up');
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('socket hang up');
  });

  it('rotates tokens through Intuit and reseals the result', async () => {
    const client = registerClient(provider);
    const { code } = await completeAuthorization(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'intuit-access-2', refresh_token: 'intuit-refresh-2', expires_in: 3600 })
    );
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    const body = new URLSearchParams((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('intuit-refresh');

    const auth = await provider.verifyAccessToken(rotated.access_token);
    expect(auth.extra).toEqual({ accessToken: 'intuit-access-2', realmId: '9130350000000' });
    expect(unseal<{ rt: string }>(rotated.refresh_token!, tokenKey, 'refresh').rt).toBe('intuit-refresh-2');
  });
});

describe('verifyAccessToken', () => {
  const provider = makeProvider();

  it('rejects garbage tokens', async () => {
    await expect(provider.verifyAccessToken('garbage')).rejects.toThrow(InvalidTokenError);
  });

  it('rejects expired tokens', async () => {
    const expired = seal({ h: 'h', at: 'a', r: '1', exp: Math.floor(Date.now() / 1000) - 10 }, tokenKey, 'access');
    await expect(provider.verifyAccessToken(expired)).rejects.toThrow('expired');
  });
});

describe('revokeToken', () => {
  const provider = makeProvider();
  const client = registerClient(provider);

  it('silently ignores tokens it did not mint (RFC 7009)', async () => {
    await provider.revokeToken!(client, { token: 'garbage' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes the wrapped Intuit refresh token', async () => {
    const refresh = seal({ h: 'h', rt: 'intuit-refresh', r: '1', iat: 0 }, tokenKey, 'refresh');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await provider.revokeToken!(client, { token: refresh });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'intuit-refresh' });
  });

  it('revokes the wrapped Intuit access token and tolerates 400 (already revoked)', async () => {
    const access = seal({ h: 'h', at: 'intuit-access', r: '1', exp: 0 }, tokenKey, 'access');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));
    await provider.revokeToken!(client, { token: access });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ token: 'intuit-access' });
  });

  it('raises on unexpected Intuit failures', async () => {
    const access = seal({ h: 'h', at: 'intuit-access', r: '1', exp: 0 }, tokenKey, 'access');
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    await expect(provider.revokeToken!(client, { token: access })).rejects.toThrow(ServerError);
  });
});
