#!/usr/bin/env node

import {
  QuickbooksClient,
  quickbooksClient,
} from "./clients/quickbooks-client.js";

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function main(): Promise<void> {
  requireEnvironment("QUICKBOOKS_CLIENT_ID");
  requireEnvironment("QUICKBOOKS_CLIENT_SECRET");
  requireEnvironment("QUICKBOOKS_REFRESH_TOKEN");
  requireEnvironment("QUICKBOOKS_REALM_ID");

  await quickbooksClient.refreshAccessToken();
  const credentials = await QuickbooksClient.getAuthCredentials();
  const environment = credentials.isSandbox ? "sandbox" : "production";

  process.stdout.write(
    [
      `export QBO_ACCESS_TOKEN=${shellQuote(credentials.accessToken)}`,
      `export QBO_REALM_ID=${shellQuote(credentials.realmId)}`,
      `export QBO_ENVIRONMENT=${shellQuote(environment)}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(
    "[token-cli] Failed to refresh QuickBooks credentials:",
    error instanceof Error ? error.message : error,
  );
  console.error("Run `npm run auth` to create a new QuickBooks connection.");
  process.exitCode = 1;
});
