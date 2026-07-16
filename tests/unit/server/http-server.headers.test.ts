import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QuickBooksHttpServerConfig } from "../../../src/http-server";

const quickbooksClientConfigs: unknown[] = [];

jest.unstable_mockModule("../../../src/index.js", () => ({
  createQuickbooksMCPServer: () =>
    new McpServer({ name: "QuickBooks Online MCP Server", version: "test" }),
}));

jest.unstable_mockModule("../../../src/clients/quickbooks-client.js", () => ({
  QuickbooksClient: class {
    constructor(config: unknown) {
      quickbooksClientConfigs.push(config);
    }
  },
  runWithQuickbooksClient: async (
    _client: unknown,
    callback: () => Promise<unknown>,
  ) => callback(),
}));

const { createQuickBooksHttpServer, loadHttpServerConfig } = await import(
  "../../../src/http-server"
);

const config: QuickBooksHttpServerConfig = {
  corsOrigin: "*",
  defaultQuickbooksEnvironment: "sandbox",
};
const server = createQuickBooksHttpServer(config);
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

function quickbooksHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: "Bearer qbo-access-token",
    "X-QuickBooks-Realm-ID": "123456789012345",
    "X-QuickBooks-Environment": "production",
    ...overrides,
  };
}

describe("caller-supplied QuickBooks credentials", () => {
  it("reports the stateless header contract as healthy", async () => {
    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      auth: "caller-supplied-quickbooks-token",
      requiredHeaders: ["Authorization", "X-QuickBooks-Realm-ID"],
      optionalHeaders: ["X-QuickBooks-Environment"],
      defaultQuickbooksEnvironment: "sandbox",
    });
  });

  it("uses the bearer token, realm, and environment for MCP initialize", async () => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...quickbooksHeaders(),
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "QuickBooks Online MCP Server" } },
    });
    expect(quickbooksClientConfigs.at(-1)).toEqual({
      accessToken: "qbo-access-token",
      realmId: "123456789012345",
      environment: "production",
      allowInteractiveAuth: false,
      persistTokensToEnv: false,
    });
  });

  it("uses the configured environment when the header is omitted", async () => {
    const headers = quickbooksHeaders();
    delete headers["X-QuickBooks-Environment"];

    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(quickbooksClientConfigs.at(-1)).toMatchObject({
      environment: "sandbox",
    });
  });

  it("rejects missing and malformed caller credentials", async () => {
    const missingToken = await fetch(`${origin}/mcp`, { method: "POST" });
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("www-authenticate")).toBe(
      'Bearer realm="quickbooks", error="invalid_token"',
    );
    await expect(missingToken.json()).resolves.toMatchObject({
      error: "missing_quickbooks_access_token",
    });

    const missingRealm = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer qbo-access-token" },
    });
    expect(missingRealm.status).toBe(400);
    await expect(missingRealm.json()).resolves.toMatchObject({
      error: "missing_quickbooks_realm_id",
    });

    const invalidRealm = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: quickbooksHeaders({ "X-QuickBooks-Realm-ID": "realm-123" }),
    });
    expect(invalidRealm.status).toBe(400);
    await expect(invalidRealm.json()).resolves.toMatchObject({
      error: "invalid_quickbooks_realm_id",
    });

    const invalidEnvironment = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: quickbooksHeaders({
        "X-QuickBooks-Environment": "staging",
      }),
    });
    expect(invalidEnvironment.status).toBe(400);
    await expect(invalidEnvironment.json()).resolves.toMatchObject({
      error: "invalid_quickbooks_environment",
    });
  });

  it("does not expose OAuth or DCR endpoints", async () => {
    for (const path of [
      "/register",
      "/authorize",
      "/token",
      "/oauth/callback",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("allows QuickBooks credential headers in CORS preflight", async () => {
    const response = await fetch(`${origin}/mcp`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-QuickBooks-Realm-ID",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-QuickBooks-Environment",
    );
  });
});

describe("HTTP server configuration", () => {
  it("does not require QuickBooks application credentials", () => {
    expect(
      loadHttpServerConfig({
        MCP_HTTP_PORT: "4000",
        MCP_CORS_ORIGIN: "https://client.example",
        QUICKBOOKS_DEFAULT_ENVIRONMENT: "production",
      }),
    ).toEqual({
      port: 4000,
      config: {
        corsOrigin: "https://client.example",
        defaultQuickbooksEnvironment: "production",
      },
    });
  });

  it("validates the default QuickBooks environment", () => {
    expect(() =>
      loadHttpServerConfig({
        QUICKBOOKS_DEFAULT_ENVIRONMENT: "invalid",
      }),
    ).toThrow("QUICKBOOKS_DEFAULT_ENVIRONMENT must be sandbox or production");
  });
});
