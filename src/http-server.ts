#!/usr/bin/env node
/**
 * Stateless Streamable HTTP entry point for the QuickBooks Online MCP server.
 *
 * Unlike the stdio entry point (index.ts), which serves one pre-authorized
 * user from .env tokens, this server lets any MCP client connect with just a
 * URL. It acts as an OAuth 2.1 authorization server that proxies Dynamic
 * Client Registration and the authorization-code flow onto Intuit (which
 * supports neither DCR nor per-client redirect URIs) — see
 * intuit-dcr-proxy-provider.ts for the mechanics.
 *
 * The MCP endpoint itself is stateless: each POST /mcp spins up a fresh
 * server + transport pair, authenticates via the sealed bearer token, and
 * streams the response back over SSE (or plain JSON for simple exchanges).
 * No sessions, no sticky routing — any replica can answer any request.
 *
 * Required environment:
 *   QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET  Intuit app credentials
 *   MCP_BASE_URL   Public URL of this server (e.g. https://qbo-mcp.example.com).
 *                  {MCP_BASE_URL}/callback must be registered as a redirect
 *                  URI on the Intuit app.
 * Optional:
 *   PORT                      Listen port (default 3000)
 *   MCP_TOKEN_ENCRYPTION_KEY  32-byte hex/base64 key for sealed tokens
 *                             (default: derived from the client secret)
 *   QUICKBOOKS_ENVIRONMENT    sandbox | production (default sandbox)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Same .env resolution as quickbooks-client.ts: relative to the installed
// module so it works no matter which directory the server is launched from.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), override: true });

import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createQboMcpServer } from "./server/create-server.js";
import { IntuitDcrProxyProvider, INTUIT_ACCOUNTING_SCOPE } from "./auth/intuit-dcr-proxy-provider.js";
import { resolveTokenEncryptionKey } from "./auth/token-crypto.js";
import { quickbooksRequestContext } from "./clients/request-context.js";

const clientId = process.env.QUICKBOOKS_CLIENT_ID;
const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error("QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set");
}

const port = Number(process.env.PORT || 3000);
const baseUrl = new URL(process.env.MCP_BASE_URL || `http://localhost:${port}`);
if (!process.env.MCP_BASE_URL) {
  console.error(`[http-server] MCP_BASE_URL is not set — defaulting to ${baseUrl.href}. OAuth only works if clients can reach this URL and it is registered on the Intuit app.`);
}
if (!process.env.MCP_TOKEN_ENCRYPTION_KEY) {
  console.error("[http-server] MCP_TOKEN_ENCRYPTION_KEY is not set — deriving the token key from the client secret. Rotating the secret will invalidate all issued tokens.");
}

const mcpUrl = new URL("/mcp", baseUrl);
const provider = new IntuitDcrProxyProvider({
  clientId,
  clientSecret,
  baseUrl,
  tokenKey: resolveTokenEncryptionKey(process.env.MCP_TOKEN_ENCRYPTION_KEY, clientSecret),
});

const app = express();

// OAuth endpoints: /.well-known metadata, /register (DCR), /authorize, /token, /revoke
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "QuickBooks Online MCP Server",
    scopesSupported: [INTUIT_ACCOUNTING_SCOPE],
    serviceDocumentationUrl: new URL("https://github.com/octaviuslabs/quickbooks-online-mcp-server"),
  })
);

// Intuit redirects the user's browser here after consent
app.get("/callback", (req, res) => {
  provider.handleIntuitCallback(req, res).catch((err) => {
    console.error("[http-server] Unhandled callback error:", err);
    if (!res.headersSent) res.status(500).send("Internal server error");
  });
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

const mcpCors = cors({ exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"] });

app.post("/mcp", mcpCors, bearerAuth, express.json({ limit: "10mb" }), async (req, res) => {
  const { accessToken, realmId } = (req.auth?.extra ?? {}) as { accessToken?: string; realmId?: string };
  if (!accessToken || !realmId) {
    // Can only happen if a token minted by an older/incompatible build passes
    // verification but lacks the QBO credentials.
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Bearer token does not carry QuickBooks credentials; re-authorize" },
      id: null,
    });
    return;
  }

  // Fresh server + transport per request: nothing survives the response, so
  // any replica can serve any request (stateless mode).
  const server = createQboMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    // Tool handlers resolve QuickBooks credentials from this context instead
    // of the env-based singleton (see request-context.ts).
    await quickbooksRequestContext.run({ accessToken, realmId }, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    console.error("[http-server] Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless transport has no standalone SSE stream or session to terminate.
const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server runs in stateless mode" },
    id: null,
  });
};
app.get("/mcp", mcpCors, methodNotAllowed);
app.delete("/mcp", mcpCors, methodNotAllowed);

app.listen(port, () => {
  console.error(`[http-server] QuickBooks MCP server listening on port ${port}`);
  console.error(`[http-server]   MCP endpoint:          ${mcpUrl.href}`);
  console.error(`[http-server]   Intuit redirect URI:   ${provider.intuitCallbackUrl} (register this on your Intuit app)`);
});
