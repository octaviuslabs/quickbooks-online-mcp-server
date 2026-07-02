import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request QuickBooks credentials for the stateless HTTP transport.
 *
 * The stdio server authenticates once from .env and shares a singleton
 * QuickBooks client. The HTTP server instead serves many users, each carrying
 * their own Intuit access token inside the (sealed) MCP bearer token. The
 * HTTP request handler unpacks those credentials and runs the MCP request
 * inside this AsyncLocalStorage context; QuickbooksClient.getInstance() and
 * getAuthCredentials() check the store first, so the ~150 tool handlers work
 * unchanged in both modes.
 */
export interface QuickbooksRequestContext {
  accessToken: string;
  realmId: string;
}

export const quickbooksRequestContext = new AsyncLocalStorage<QuickbooksRequestContext>();
