/**
 * Behavioral tests for QuickbooksClient static-token mode (HTTP transport).
 *
 * In static-token mode the client is built from a caller-supplied access
 * token + realm ID and must never perform OAuth: no interactive flow, no
 * refresh. Token renewal is the caller's job. Request scoping happens via
 * AsyncLocalStorage so the static getInstance()/getAuthCredentials() entry
 * points used by every tool handler resolve the per-request client instead of
 * the env singleton.
 */
import { jest } from "@jest/globals";

process.env.QUICKBOOKS_CLIENT_ID = "env-client-id";
process.env.QUICKBOOKS_CLIENT_SECRET = "env-client-secret";
process.env.QUICKBOOKS_REFRESH_TOKEN = "env-refresh-token";
process.env.QUICKBOOKS_REALM_ID = "env-realm";
process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";

const oauthConstructions: Record<string, unknown>[] = [];
jest.unstable_mockModule("intuit-oauth", () => {
  class MockOAuthClient {
    static scopes = { Accounting: "com.intuit.quickbooks.accounting" };
    constructor(cfg: Record<string, unknown>) {
      oauthConstructions.push(cfg);
    }
    refreshUsingToken = jest.fn(async () => {
      throw new Error("refresh must not be called in static-token mode");
    });
  }
  return { default: MockOAuthClient };
});

const quickbooksConstructions: unknown[][] = [];
jest.unstable_mockModule("node-quickbooks", () => ({
  default: class MockQuickBooks {
    constructor(...args: unknown[]) {
      quickbooksConstructions.push(args);
    }
  },
}));

jest.unstable_mockModule("open", () => ({
  default: jest.fn(async () => undefined),
}));

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
jest.unstable_mockModule("fs", () => ({
  default: {
    readFileSync: jest.fn(() => {
      throw enoent();
    }),
    existsSync: jest.fn(() => false),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
  },
}));

const { QuickbooksClient, runWithQuickbooksClient } = await import(
  "../../../src/clients/quickbooks-client"
);

const staticConfig = {
  accessToken: "caller-access-token",
  realmId: "caller-realm",
  environment: "production",
};

describe("QuickbooksClient static-token mode", () => {
  it("authenticate() builds the QuickBooks instance from the supplied token without any OAuth", async () => {
    const client = new QuickbooksClient(staticConfig);

    const instance = await client.authenticate();

    expect(instance).toBe(client.getQuickbooks());
    expect(oauthConstructions).toHaveLength(0);

    const args = quickbooksConstructions.at(-1)!;
    expect(args[2]).toBe("caller-access-token"); // access token
    expect(args[4]).toBe("caller-realm"); // realm id
    expect(args[5]).toBe(false); // production → not sandbox
  });

  it("refreshAccessToken() refuses to refresh", async () => {
    const client = new QuickbooksClient(staticConfig);

    await expect(client.refreshAccessToken()).rejects.toThrow(
      /does not refresh tokens/,
    );
  });

  it("authenticate() requires a realm ID", async () => {
    const client = new QuickbooksClient({
      ...staticConfig,
      realmId: undefined,
    });

    await expect(client.authenticate()).rejects.toThrow(/realm ID is required/);
  });

  it("static getInstance()/getAuthCredentials() resolve the request-scoped client via AsyncLocalStorage", async () => {
    const client = new QuickbooksClient(staticConfig);

    const { instance, credentials } = await runWithQuickbooksClient(
      client,
      async () => ({
        instance: await QuickbooksClient.getInstance(),
        credentials: await QuickbooksClient.getAuthCredentials(),
      }),
    );

    expect(instance).toBe(client.getQuickbooks());
    expect(credentials).toEqual({
      accessToken: "caller-access-token",
      realmId: "caller-realm",
      isSandbox: false,
    });
    // The token is used as-is: no expiry tracking, so repeated calls must not
    // trigger any refresh (the mocked refresh throws if reached).
    await runWithQuickbooksClient(client, () => QuickbooksClient.getInstance());
    expect(oauthConstructions).toHaveLength(0);
  });
});
