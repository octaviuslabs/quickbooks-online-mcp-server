#!/usr/bin/env node
/**
 * Local QuickBooks OAuth helper
 *
 * Usage: npm run auth
 *
 * This script initiates the OAuth 2.0 flow to obtain QuickBooks API tokens.
 * It will:
 * 1. Start a local server on port 8000
 * 2. Open your browser to the QuickBooks authorization page
 * 3. Handle the callback and save tokens to .env
 * 4. Close automatically when complete
 *
 * Prerequisites:
 * - QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set in .env
 * - QUICKBOOKS_REDIRECT_URI must be registered exactly in your Intuit app
 */

import {
  QuickbooksClient,
  quickbooksClient,
} from "./clients/quickbooks-client.js";

async function main() {
  console.log("QuickBooks OAuth Authentication");
  console.log("================================\n");
  console.log("Starting OAuth flow...");
  console.log(
    "A browser window will open for you to authorize the application.\n",
  );

  try {
    // The authenticate method will trigger the OAuth flow if no tokens exist
    await quickbooksClient.authenticate();
    const credentials = await QuickbooksClient.getAuthCredentials();

    console.log("\n✓ Successfully authenticated with QuickBooks!");
    console.log("The rotating refresh token and realm ID were saved to .env.");
    console.log("\nUse these values for the current Codex session:\n");
    console.log(`export QBO_ACCESS_TOKEN='${credentials.accessToken}'`);
    console.log(`export QBO_REALM_ID='${credentials.realmId}'`);
    console.log(
      `export QBO_ENVIRONMENT='${credentials.isSandbox ? "sandbox" : "production"}'`,
    );
    console.log(
      '\nWhen the access token expires, run: eval "$(npm run token --silent)"',
    );

    process.exit(0);
  } catch (error) {
    console.error("\n✗ Authentication failed:", error);
    console.error("\nPlease check:");
    console.error("1. QUICKBOOKS_CLIENT_ID is set correctly in .env");
    console.error("2. QUICKBOOKS_CLIENT_SECRET is set correctly in .env");
    console.error(
      "3. QUICKBOOKS_REDIRECT_URI is registered exactly in your Intuit app",
    );

    process.exit(1);
  }
}

main();
