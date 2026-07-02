import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { seal, unseal, TokenSealError } from "./token-crypto.js";

/**
 * OAuth 2.1 authorization server that proxies Dynamic Client Registration
 * (RFC 7591) and the authorization-code flow onto Intuit's OAuth service.
 *
 * Intuit does not support DCR, and every Intuit app has exactly one
 * client_id/secret with pre-registered redirect URIs. This provider bridges
 * the gap so any MCP client can connect by URL alone:
 *
 *   MCP client  ──register/authorize/token──▶  this proxy  ──▶  Intuit
 *
 * - /register mints a client_id that IS the sealed registration record, so
 *   no registration storage is needed.
 * - /authorize redirects the user to Intuit's consent page, carrying the MCP
 *   client's redirect_uri, state, and PKCE challenge inside a sealed `state`.
 * - Intuit calls back to {baseUrl}/callback (the one redirect URI registered
 *   on the Intuit app). The proxy exchanges the Intuit code immediately
 *   (Intuit codes are short-lived) and seals the resulting tokens into the
 *   authorization code it issues to the MCP client.
 * - /token unseals that code, enforces PKCE via the SDK, and returns sealed
 *   access/refresh tokens wrapping the Intuit tokens + realm ID.
 *
 * All state lives inside the sealed tokens, so any number of replicas can
 * serve any request. The one stateless trade-off: authorization codes cannot
 * be marked single-use, so they simply expire quickly instead.
 */

export const INTUIT_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";

const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

// Lifetimes for proxy-minted artifacts (seconds)
const STATE_TTL_SECONDS = 10 * 60; // authorize redirect -> Intuit callback
const CODE_TTL_SECONDS = 5 * 60; // Intuit callback -> token exchange

interface SealedClient {
  /** redirect_uris */
  r: string[];
  /** client_secret (absent for public clients) */
  s?: string;
  /** scope granted at registration */
  sc: string;
  /** client_name, echoed back for debugging */
  n?: string;
  /** issued-at (epoch seconds) */
  iat: number;
}

interface SealedState {
  /** sha256(client_id), base64url */
  h: string;
  /** MCP client's redirect_uri */
  u: string;
  /** PKCE code_challenge (S256) */
  c: string;
  /** MCP client's original state, if any */
  t?: string;
  iat: number;
}

interface SealedCode {
  h: string;
  u: string;
  c: string;
  /** Intuit access token */
  at: string;
  /** Intuit refresh token */
  rt: string;
  /** Intuit access token expiry (epoch seconds) */
  ax: number;
  /** QuickBooks company (realm) ID */
  r: string;
  iat: number;
}

interface SealedAccessToken {
  h: string;
  at: string;
  r: string;
  /** expiry (epoch seconds) */
  exp: number;
}

interface SealedRefreshToken {
  h: string;
  rt: string;
  r: string;
  iat: number;
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
}

export interface IntuitDcrProxyConfig {
  /** Intuit app client ID */
  clientId: string;
  /** Intuit app client secret */
  clientSecret: string;
  /** Public base URL of this server, e.g. https://qbo-mcp.example.com */
  baseUrl: URL;
  /** 32-byte key for sealing tokens (see resolveTokenEncryptionKey) */
  tokenKey: Buffer;
  /** Intuit scope to request; defaults to accounting */
  scope?: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hashClientId = (clientId: string) => crypto.createHash("sha256").update(clientId, "utf-8").digest("base64url");

export class IntuitDcrProxyProvider implements OAuthServerProvider {
  private readonly config: Required<IntuitDcrProxyConfig>;

  constructor(config: IntuitDcrProxyConfig) {
    this.config = { scope: INTUIT_ACCOUNTING_SCOPE, ...config };
  }

  /** Redirect URI registered on the Intuit app: {baseUrl}/callback */
  get intuitCallbackUrl(): string {
    return new URL("/callback", this.config.baseUrl).href;
  }

  // ── Dynamic Client Registration (stateless) ──────────────────────────────
  // The client_id itself is the sealed registration record, so getClient()
  // can reconstruct the registration on any replica with zero storage.

  get clientsStore(): OAuthRegisteredClientsStore {
    const key = this.config.tokenKey;
    const defaultScope = this.config.scope;
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        let sealed: SealedClient;
        try {
          sealed = unseal<SealedClient>(clientId, key, "client");
        } catch {
          return undefined;
        }
        return {
          client_id: clientId,
          client_id_issued_at: sealed.iat,
          client_secret: sealed.s,
          // Sealed client secrets never expire; clients simply re-register
          // (for free) if they lose them.
          client_secret_expires_at: sealed.s ? 0 : undefined,
          redirect_uris: sealed.r,
          client_name: sealed.n,
          scope: sealed.sc,
          token_endpoint_auth_method: sealed.s ? "client_secret_post" : "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
      },
      registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
        const sealed: SealedClient = {
          r: client.redirect_uris,
          s: client.client_secret,
          sc: client.scope ?? defaultScope,
          n: client.client_name,
          iat: nowSeconds(),
        };
        return {
          ...client,
          client_id: seal(sealed, key, "client"),
          client_id_issued_at: sealed.iat,
          client_secret_expires_at: client.client_secret ? 0 : undefined,
          scope: sealed.sc,
        };
      },
    };
  }

  // ── Authorization ─────────────────────────────────────────────────────────

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state: SealedState = {
      h: hashClientId(client.client_id),
      u: params.redirectUri,
      c: params.codeChallenge,
      t: params.state,
      iat: nowSeconds(),
    };

    const url = new URL(INTUIT_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.config.scope);
    url.searchParams.set("redirect_uri", this.intuitCallbackUrl);
    url.searchParams.set("state", seal(state, this.config.tokenKey, "state"));
    res.redirect(302, url.toString());
  }

  /**
   * Handles Intuit's redirect back to {baseUrl}/callback. Exchanges the
   * Intuit authorization code right away (it expires in minutes and is bound
   * to this proxy's redirect URI), then forwards a proxy-minted code — with
   * the Intuit tokens sealed inside — to the MCP client's redirect URI.
   */
  async handleIntuitCallback(req: Request, res: Response): Promise<void> {
    const { code, state, realmId, error, error_description } = req.query as Record<string, string | undefined>;

    if (!state) {
      res.status(400).send("Missing state parameter");
      return;
    }

    let sealedState: SealedState;
    try {
      sealedState = unseal<SealedState>(state, this.config.tokenKey, "state");
    } catch {
      res.status(400).send("Invalid or expired state parameter");
      return;
    }

    const clientRedirect = new URL(sealedState.u);
    if (sealedState.t) {
      clientRedirect.searchParams.set("state", sealedState.t);
    }

    const redirectError = (code: string, description: string) => {
      clientRedirect.searchParams.set("error", code);
      clientRedirect.searchParams.set("error_description", description);
      res.redirect(302, clientRedirect.toString());
    };

    if (error) {
      redirectError(error, error_description ?? "Authorization with Intuit failed");
      return;
    }
    if (nowSeconds() - sealedState.iat > STATE_TTL_SECONDS) {
      redirectError("access_denied", "Authorization took too long; please retry");
      return;
    }
    if (!code || !realmId) {
      redirectError("invalid_request", "Intuit callback is missing code or realmId");
      return;
    }

    let tokens: IntuitTokenResponse;
    try {
      tokens = await this.intuitTokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.intuitCallbackUrl,
      });
    } catch (err) {
      console.error("[dcr-proxy] Intuit code exchange failed:", err);
      redirectError("server_error", "Failed to exchange authorization code with Intuit");
      return;
    }

    const sealedCode: SealedCode = {
      h: sealedState.h,
      u: sealedState.u,
      c: sealedState.c,
      at: tokens.access_token,
      rt: tokens.refresh_token,
      ax: nowSeconds() + tokens.expires_in,
      r: realmId,
      iat: nowSeconds(),
    };
    clientRedirect.searchParams.set("code", seal(sealedCode, this.config.tokenKey, "code"));
    res.redirect(302, clientRedirect.toString());
  }

  // ── Token endpoint ────────────────────────────────────────────────────────

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.unsealCode(client, authorizationCode).c;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const sealedCode = this.unsealCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== sealedCode.u) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.mintTokens(sealedCode.h, {
      access_token: sealedCode.at,
      refresh_token: sealedCode.rt,
      expires_in: Math.max(0, sealedCode.ax - nowSeconds()),
    }, sealedCode.r);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    let sealed: SealedRefreshToken;
    try {
      sealed = unseal<SealedRefreshToken>(refreshToken, this.config.tokenKey, "refresh");
    } catch {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (sealed.h !== hashClientId(client.client_id)) {
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }

    let tokens: IntuitTokenResponse;
    try {
      tokens = await this.intuitTokenRequest({
        grant_type: "refresh_token",
        refresh_token: sealed.rt,
      });
    } catch (err) {
      // Intuit rotates refresh tokens; a rejected one means the user must
      // re-authorize. Surface it as invalid_grant so clients restart the flow.
      throw new InvalidGrantError(`Intuit refused the refresh token: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.mintTokens(sealed.h, tokens, sealed.r);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let sealed: SealedAccessToken;
    try {
      sealed = unseal<SealedAccessToken>(token, this.config.tokenKey, "access");
    } catch {
      throw new InvalidTokenError("Invalid access token");
    }
    if (sealed.exp <= nowSeconds()) {
      throw new InvalidTokenError("Access token has expired");
    }
    return {
      token,
      clientId: sealed.h,
      scopes: [this.config.scope],
      expiresAt: sealed.exp,
      extra: {
        accessToken: sealed.at,
        realmId: sealed.r,
      },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Determine which kind of sealed token we were handed; per RFC 7009 an
    // unrecognized token is silently ignored.
    let intuitToken: string | undefined;
    try {
      intuitToken = unseal<SealedRefreshToken>(request.token, this.config.tokenKey, "refresh").rt;
    } catch {
      try {
        intuitToken = unseal<SealedAccessToken>(request.token, this.config.tokenKey, "access").at;
      } catch {
        return;
      }
    }

    const response = await fetch(INTUIT_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.basicAuth()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token: intuitToken }),
    });
    // Intuit returns 400 for already-revoked/unknown tokens — that satisfies
    // revocation semantics, so only unexpected statuses are errors.
    if (!response.ok && response.status !== 400) {
      throw new ServerError(`Intuit token revocation failed with status ${response.status}`);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private unsealCode(client: OAuthClientInformationFull, authorizationCode: string): SealedCode {
    let sealed: SealedCode;
    try {
      sealed = unseal<SealedCode>(authorizationCode, this.config.tokenKey, "code");
    } catch {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (sealed.h !== hashClientId(client.client_id)) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }
    if (nowSeconds() - sealed.iat > CODE_TTL_SECONDS) {
      throw new InvalidGrantError("Authorization code has expired");
    }
    return sealed;
  }

  private mintTokens(clientIdHash: string, tokens: Pick<IntuitTokenResponse, "access_token" | "refresh_token" | "expires_in">, realmId: string): OAuthTokens {
    const accessToken: SealedAccessToken = {
      h: clientIdHash,
      at: tokens.access_token,
      r: realmId,
      exp: nowSeconds() + tokens.expires_in,
    };
    const refreshToken: SealedRefreshToken = {
      h: clientIdHash,
      rt: tokens.refresh_token,
      r: realmId,
      iat: nowSeconds(),
    };
    return {
      access_token: seal(accessToken, this.config.tokenKey, "access"),
      token_type: "bearer",
      expires_in: tokens.expires_in,
      refresh_token: seal(refreshToken, this.config.tokenKey, "refresh"),
      scope: this.config.scope,
    };
  }

  private basicAuth(): string {
    return Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf-8").toString("base64");
  }

  private async intuitTokenRequest(params: Record<string, string>): Promise<IntuitTokenResponse> {
    const response = await fetch(INTUIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.basicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Intuit token endpoint returned ${response.status}: ${body.slice(0, 500)}`);
    }
    return (await response.json()) as IntuitTokenResponse;
  }
}

// Re-exported so tests and the HTTP entry point don't reach into internals.
export { TokenSealError };
