import dotenv from "dotenv";
import crypto from "node:crypto";
import QuickBooks from "node-quickbooks";
import OAuthClient from "intuit-oauth";
import http from "http";
import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { fileURLToPath } from "url";
import open from "open";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = process.argv[1] ? path.basename(process.argv[1]) : "";
const isHttpEntrypoint = entrypoint.startsWith("http-server.");

// Resolve .env relative to the installed module (../../.env from dist/clients/).
// This matters when the MCP server is spawned by a host (e.g. Claude Desktop,
// Claude Code, Cursor) whose working directory is not the project root —
// without this, dotenv silently finds nothing and startup fails.
//
// Use override: true so that values from .env always win over any empty-string
// placeholders a host app (e.g. Claude Desktop) may inject via its env config.
// This prevents the server from starting with blank REFRESH_TOKEN / REALM_ID
// even when the host config has those keys set to "".
if (!isHttpEntrypoint) {
  dotenv.config({
    path: path.join(__dirname, "..", "..", ".env"),
    override: true,
  });
}

// Register once at module level — registering inside startOAuthFlow() would
// accumulate duplicate handlers on every OAuth call.
process.on("uncaughtException", (err) => {
  console.error("[qbo-client] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[qbo-client] unhandledRejection:", reason);
});

const client_id = isHttpEntrypoint
  ? undefined
  : process.env.QUICKBOOKS_CLIENT_ID;
const client_secret = isHttpEntrypoint
  ? undefined
  : process.env.QUICKBOOKS_CLIENT_SECRET;
const refresh_token = isHttpEntrypoint
  ? undefined
  : process.env.QUICKBOOKS_REFRESH_TOKEN;
const realm_id = isHttpEntrypoint ? undefined : process.env.QUICKBOOKS_REALM_ID;
const environment = isHttpEntrypoint
  ? "sandbox"
  : process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
// Fix for Issue #5: Use env var with underscore (QUICKBOOKS_REDIRECT_URI)
const redirect_uri = isHttpEntrypoint
  ? "http://localhost:8000/callback"
  : process.env.QUICKBOOKS_REDIRECT_URI || "http://localhost:8000/callback";

export interface QuickbooksClientConfig {
  clientId?: string;
  clientSecret?: string;
  // When set, the client runs in static-token mode: it uses this access token
  // as-is and never performs OAuth (no interactive flow, no refresh). The
  // token owner is responsible for refreshing and retrying on auth failures.
  accessToken?: string;
  refreshToken?: string;
  realmId?: string;
  environment: string;
  redirectUri?: string;
  allowInteractiveAuth?: boolean;
  persistTokensToEnv?: boolean;
  onTokensUpdated?: (tokens: QuickbooksTokenUpdate) => void;
}

export interface QuickbooksTokenUpdate {
  accessToken?: string;
  refreshToken?: string;
  realmId?: string;
  expiresIn?: number;
}

const quickbooksClientStorage = new AsyncLocalStorage<QuickbooksClient>();

export function runWithQuickbooksClient<T>(
  client: QuickbooksClient,
  callback: () => T,
): T {
  return quickbooksClientStorage.run(client, callback);
}

// ── QuickbooksClient ─────────────────────────────────────────────────────────
// Exported so handlers can call QuickbooksClient.getInstance() directly,
// which checks token freshness on every invocation rather than only at startup.

export class QuickbooksClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken?: string;
  private realmId?: string;
  private readonly environment: string;
  private accessToken?: string;
  private accessTokenExpiry?: Date;
  private quickbooksInstance?: QuickBooks;
  private oauthClient?: OAuthClient;
  private isAuthenticating: boolean = false;
  private redirectUri: string;
  private readonly staticAccessToken: boolean;
  private readonly allowInteractiveAuth: boolean;
  private readonly persistTokensToEnv: boolean;
  private readonly onTokensUpdated?: (tokens: QuickbooksTokenUpdate) => void;

  // Refresh 5 minutes before actual expiry to avoid edge cases
  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  // Shared in-flight refresh promise so that concurrent callers all await the
  // same network request rather than racing to use (and rotate) the refresh
  // token simultaneously.
  private refreshInFlight?: Promise<{
    access_token: string;
    expires_in: number;
  }>;

  // Shared in-flight authenticate promise. Guards the cold-start path so two
  // concurrent first callers cannot both pass the freshness check and both
  // invoke startOAuthFlow() / rebuild the QuickBooks instance.
  private authInFlight?: Promise<QuickBooks>;

  constructor(config: QuickbooksClientConfig) {
    this.clientId = config.clientId ?? "";
    this.clientSecret = config.clientSecret ?? "";
    this.staticAccessToken = Boolean(config.accessToken);
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.realmId = config.realmId;
    this.environment = config.environment;
    this.redirectUri = config.redirectUri ?? "";
    this.allowInteractiveAuth = config.allowInteractiveAuth ?? true;
    this.persistTokensToEnv = config.persistTokensToEnv ?? true;
    this.onTokensUpdated = config.onTokensUpdated;
  }

  private isTokenExpiredOrExpiringSoon(): boolean {
    // Static-token mode has no expiry knowledge: the token is used as-is and
    // QuickBooks rejects it when expired — refreshing is the caller's job.
    if (this.staticAccessToken) return false;
    if (!this.accessToken || !this.accessTokenExpiry) return true;
    return (
      this.accessTokenExpiry <=
      new Date(Date.now() + QuickbooksClient.TOKEN_REFRESH_BUFFER_MS)
    );
  }

  private validateClientCredentials(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new Error("Client ID and Client Secret must be set");
    }
  }

  private getOAuthClient(): OAuthClient {
    this.validateClientCredentials();

    if (!this.oauthClient) {
      this.oauthClient = new OAuthClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        environment: this.environment,
        redirectUri: this.redirectUri || "http://localhost:8000/callback",
      });
    }

    return this.oauthClient;
  }

  private async startOAuthFlow(): Promise<void> {
    this.validateClientCredentials();

    if (this.isAuthenticating) {
      return;
    }

    this.isAuthenticating = true;
    const port = 8000;
    const expectedState = crypto.randomBytes(32).toString("base64url");
    const flowRedirectUri =
      this.redirectUri || `http://localhost:${port}/callback`;

    // The same redirect URI must be used for authorization and code exchange.
    // A public HTTPS URI can point at this listener through a local tunnel.
    const flowClient = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: flowRedirectUri,
    });

    return new Promise((resolve, reject) => {
      // Create temporary server for OAuth callback
      const server = http.createServer(async (req, res) => {
        console.log(`[auth-server] ${req.method} ${req.url}`);

        // Respond to anything that isn't /callback so diagnostic probes (curl,
        // ngrok health checks, favicon requests, etc.) don't hang the server.
        if (!req.url?.startsWith("/callback")) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end(
            "Not Found. Waiting for QuickBooks OAuth callback at /callback",
          );
          return;
        }

        {
          try {
            const callbackUrl = new URL(req.url, `http://localhost:${port}`);
            const returnedState = callbackUrl.searchParams.get("state");
            if (returnedState !== expectedState) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Invalid OAuth state");
              return;
            }

            const response = await flowClient.createToken(req.url);
            const tokens = response.token as unknown as {
              access_token: string;
              refresh_token: string;
              expires_in?: number;
              realmId: string;
            };

            // Save tokens
            this.accessToken = tokens.access_token;
            this.accessTokenExpiry = new Date(
              Date.now() + (tokens.expires_in || 3600) * 1000,
            );
            this.refreshToken = tokens.refresh_token;
            this.realmId = tokens.realmId;
            this.saveTokensToEnv();

            // Send success response
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #f5f5f5;
                ">
                  <h2 style="color: #2E8B57;">✓ Successfully connected to QuickBooks!</h2>
                  <p>You can close this window now.</p>
                </body>
              </html>
            `);

            // Close server after a short delay
            setTimeout(() => {
              server.close();
              this.isAuthenticating = false;
              resolve();
            }, 1000);
          } catch (error) {
            console.error("Error during token creation:", error);
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #fff0f0;
                ">
                  <h2 style="color: #d32f2f;">Error connecting to QuickBooks</h2>
                  <p>Please check the console for more details.</p>
                </body>
              </html>
            `);
            this.isAuthenticating = false;
            reject(error);
          }
        }
      });

      // The authorization helper is local-only; never expose its callback
      // listener on LAN interfaces.
      server.listen(port, "127.0.0.1", async () => {
        const addr = server.address();
        console.log(
          `[auth-server] Listening on ${typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`} (family: ${typeof addr === "object" ? addr?.family : "n/a"})`,
        );

        // Generate authorization URL with proper type assertion
        const authUri = flowClient
          .authorizeUri({
            scope: [OAuthClient.scopes.Accounting as string],
            state: expectedState,
          })
          .toString();

        console.log("\n=== QuickBooks Authorization ===");
        console.log("Open this URL in a browser to authorize:\n");
        console.log(authUri);
        console.log("\nWaiting for callback...\n");

        // Attempt to open the browser automatically; ignore failures on headless systems
        try {
          await open(authUri);
        } catch {
          // Headless environment — user will open the URL manually
        }
      });

      // Handle server errors
      server.on("error", (error) => {
        console.error("Server error:", error);
        this.isAuthenticating = false;
        reject(error);
      });
    });
  }

  private saveTokensToEnv(): void {
    const tokenPath = path.join(__dirname, "..", "..", ".env");
    const envContent = fs.existsSync(tokenPath)
      ? fs.readFileSync(tokenPath, "utf-8")
      : "";
    const envLines = envContent.split("\n");

    const updateEnvVar = (name: string, value: string) => {
      const index = envLines.findIndex((line) => line.startsWith(`${name}=`));
      if (index !== -1) {
        envLines[index] = `${name}=${value}`;
      } else {
        envLines.push(`${name}=${value}`);
      }
    };

    if (this.refreshToken)
      updateEnvVar("QUICKBOOKS_REFRESH_TOKEN", this.refreshToken);
    if (this.realmId) updateEnvVar("QUICKBOOKS_REALM_ID", this.realmId);

    // Atomic write: write to a sibling temp file, then rename. On POSIX rename
    // is atomic within the same filesystem, so a crash mid-write cannot leave
    // .env half-written or empty.
    const tmpPath = `${tokenPath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, envLines.join("\n"), { mode: 0o600 });
      fs.renameSync(tmpPath, tokenPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  async refreshAccessToken() {
    if (this.staticAccessToken) {
      throw new Error(
        "This QuickBooks client uses a caller-supplied access token and does not refresh tokens",
      );
    }

    this.validateClientCredentials();

    if (!this.refreshToken) {
      if (!this.allowInteractiveAuth) {
        throw new Error("QuickBooks refresh token is required");
      }

      await this.startOAuthFlow();

      // Verify we have a refresh token after OAuth flow
      if (!this.refreshToken) {
        throw new Error("Failed to obtain refresh token from OAuth flow");
      }
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        // At this point we know refreshToken is not undefined
        const authResponse = await this.getOAuthClient().refreshUsingToken(
          this.refreshToken!,
        );

        // The intuit-oauth type declarations are incomplete — the runtime
        // token object also contains refresh_token, x_refresh_token_expires_in,
        // token_type, realmId, etc. Widen the type to reach those fields.
        const token = authResponse.token as unknown as {
          access_token: string;
          expires_in?: number;
          refresh_token?: string;
          x_refresh_token_expires_in?: number;
        };

        this.accessToken = token.access_token;

        const expiresIn = token.expires_in || 3600;
        this.accessTokenExpiry = new Date(Date.now() + expiresIn * 1000);

        // Intuit rotates the refresh token (typically every ~24h). When a new
        // one is issued we MUST surface it to the token owner; the old value
        // eventually stops working and silently breaks refresh.
        const newRefreshToken = token.refresh_token;
        if (newRefreshToken && newRefreshToken !== this.refreshToken) {
          this.refreshToken = newRefreshToken;
          this.onTokensUpdated?.({
            accessToken: this.accessToken,
            refreshToken: newRefreshToken,
            realmId: this.realmId,
            expiresIn,
          });

          if (this.persistTokensToEnv) {
            try {
              this.saveTokensToEnv();
              console.error(
                "[qbo-client] Refresh token rotated and persisted to .env",
              );
            } catch (persistErr) {
              // Don't fail the whole refresh just because we couldn't write to
              // disk; the in-memory token is still valid for this process.
              console.error(
                "[qbo-client] Failed to persist rotated refresh token:",
                persistErr,
              );
            }
          }
        }

        // Surface the refresh token's own remaining lifetime for observability.
        // Intuit's refresh tokens last 100 days; warn when under 14 days.
        const refreshExpiresIn = token.x_refresh_token_expires_in;
        if (
          typeof refreshExpiresIn === "number" &&
          refreshExpiresIn < 14 * 24 * 3600
        ) {
          const days = Math.round(refreshExpiresIn / 86400);
          console.error(
            `[qbo-client] WARNING: refresh token expires in ~${days} day(s). Re-run \`npm run auth\` before it expires.`,
          );
        }

        return {
          access_token: this.accessToken!,
          expires_in: expiresIn,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to refresh Quickbooks token: ${message}`);
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }

  async authenticate(): Promise<QuickBooks> {
    if (this.authInFlight) {
      return this.authInFlight;
    }

    this.authInFlight = (async () => {
      try {
        // Static-token mode: build the QuickBooks instance directly from the
        // caller-supplied access token. No OAuth flow, no refresh — an expired
        // token surfaces as a QuickBooks auth error for the caller to handle.
        if (this.staticAccessToken) {
          if (!this.realmId) {
            throw new Error("QuickBooks realm ID is required");
          }

          this.quickbooksInstance = new QuickBooks(
            this.clientId,
            this.clientSecret,
            this.accessToken!,
            false, // no token secret for OAuth 2.0
            this.realmId,
            this.environment === "sandbox",
            false, // debug?
            null, // minor version
            "2.0", // oauth version
            this.refreshToken,
          );

          return this.quickbooksInstance;
        }

        if (!this.refreshToken || !this.realmId) {
          if (!this.allowInteractiveAuth) {
            throw new Error(
              "QuickBooks refresh token and realm ID are required",
            );
          }

          await this.startOAuthFlow();

          // Verify we have both tokens after OAuth flow
          if (!this.refreshToken || !this.realmId) {
            throw new Error("Failed to obtain required tokens from OAuth flow");
          }
        }

        // Silently refresh if token is expired or expiring soon
        if (this.isTokenExpiredOrExpiringSoon()) {
          try {
            await this.refreshAccessToken();
          } catch (error) {
            if (!this.allowInteractiveAuth) {
              throw error;
            }

            // A dead refresh token (rotated by another consumer, past the
            // 100-day window, or revoked) is recoverable: fall back to the
            // interactive OAuth flow instead of failing hard.
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[qbo-client] Token refresh failed (${message}); falling back to interactive OAuth`,
            );
            this.refreshToken = undefined;
            this.accessToken = undefined;
            this.accessTokenExpiry = undefined;
            // With no refresh token, refreshAccessToken() starts the OAuth
            // flow and then exchanges the newly obtained refresh token.
            await this.refreshAccessToken();
          }
        }

        // Always rebuild with the current fresh access token
        this.quickbooksInstance = new QuickBooks(
          this.clientId,
          this.clientSecret,
          this.accessToken!,
          false, // no token secret for OAuth 2.0
          this.realmId!,
          this.environment === "sandbox",
          false, // debug?
          null, // minor version
          "2.0", // oauth version
          this.refreshToken,
        );

        return this.quickbooksInstance;
      } finally {
        this.authInFlight = undefined;
      }
    })();

    return this.authInFlight;
  }

  // ── Called by every handler on every request ─────────────────────────────
  // Checks token freshness on each invocation so handlers stay functional
  // across 60-minute token boundaries without server restarts.
  static async getInstance(): Promise<QuickBooks> {
    const client = QuickbooksClient.getActiveClient();

    if (client.isTokenExpiredOrExpiringSoon()) {
      await client.authenticate();
    }
    if (!client.quickbooksInstance) {
      await client.authenticate();
    }
    return client.quickbooksInstance!;
  }

  // Static counterpart to getInstance() — returns raw OAuth credentials for
  // handlers that need to call QBO endpoints not wrapped by node-quickbooks
  // (e.g. POST /upload for binary attachments). Ensures token freshness on
  // every invocation, same as getInstance().
  static async getAuthCredentials(): Promise<{
    accessToken: string;
    realmId: string;
    isSandbox: boolean;
  }> {
    const client = QuickbooksClient.getActiveClient();

    if (client.isTokenExpiredOrExpiringSoon() || !client.accessToken) {
      await client.authenticate();
    }
    if (!client.accessToken || !client.realmId) {
      throw new Error("Quickbooks not authenticated");
    }
    return {
      accessToken: client.accessToken,
      realmId: client.realmId,
      isSandbox: client.environment === "sandbox",
    };
  }

  private static getActiveClient(): QuickbooksClient {
    return quickbooksClientStorage.getStore() ?? quickbooksClient;
  }

  getQuickbooks() {
    if (!this.quickbooksInstance) {
      throw new Error(
        "Quickbooks not authenticated. Call authenticate() first",
      );
    }
    return this.quickbooksInstance;
  }
}

export const quickbooksClient = new QuickbooksClient({
  clientId: client_id,
  clientSecret: client_secret,
  refreshToken: refresh_token,
  realmId: realm_id,
  environment: environment,
  redirectUri: redirect_uri,
});
