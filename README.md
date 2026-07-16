# QuickBooks Online MCP Server

<div align="center">

**A comprehensive Model Context Protocol (MCP) server for QuickBooks Online**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/Tools-144-green.svg)](#available-tools)
[![Entities](https://img.shields.io/badge/Entities-29-orange.svg)](#entities)
[![Reports](https://img.shields.io/badge/Reports-11-purple.svg)](#reports)
[![Tests](https://img.shields.io/badge/Tests-489-blue.svg)](#testing)

[Quick Start](#quick-start) | [Available Tools](#available-tools) | [Authentication](#authentication) | [Documentation](#documentation)

</div>

---

## Overview

This MCP server provides complete QuickBooks Online API integration for Claude Code and other MCP-compatible clients. It includes full CRUD operations for 29 entity types and 11 financial reports, giving you comprehensive access to QuickBooks Online functionality.

### Key Features

- **144 Total Tools** - Complete coverage of QuickBooks Online API
- **29 Entity Types** - Full CRUD operations (Create, Read, Update, Delete, Search)
- **11 Financial Reports** - Balance Sheet, P&L, Cash Flow, and more
- **Caller-managed OAuth 2.0** - Stateless HTTP credential passthrough
- **TypeScript** - Full type safety with Zod validation
- **Tested** - Jest test suite with ESM support

> Note: this server supports local stdio usage and containerized Streamable HTTP. HTTP mode is stateless: the MCP client supplies a current QuickBooks access token and company realm ID on every request.

> **Before you start:** QuickBooks Online integration requires an app registered in the [Intuit Developer Portal](https://developer.intuit.com). Its client ID, client secret, refresh token, and OAuth callback remain with the caller-side helper; they are never configured on the MCP container. See [Authentication](#authentication).

---

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/mcp-quickbooks-online.git
cd mcp-quickbooks-online

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

Copy the template `.env.example` to `.env` in the root directory:

```bash
cp .env.example .env
```

Configure the Docker listener and the local OAuth helper:

```env
MCP_HOST_IP=127.0.0.1
MCP_HOST_PORT=3000
QUICKBOOKS_DEFAULT_ENVIRONMENT=sandbox

# Local helper only; Docker Compose does not pass these into the container.
QUICKBOOKS_CLIENT_ID=your_intuit_client_id
QUICKBOOKS_CLIENT_SECRET=your_intuit_client_secret
QUICKBOOKS_ENVIRONMENT=sandbox
QUICKBOOKS_REDIRECT_URI=http://localhost:8000/callback

# Optional: restrict which tool categories are registered (default: all enabled)
# QUICKBOOKS_DISABLE_WRITE=true    # suppress create_* tools
# QUICKBOOKS_DISABLE_UPDATE=true   # suppress update_* tools
# QUICKBOOKS_DISABLE_DELETE=true   # suppress delete_* tools
```

Register `QUICKBOOKS_REDIRECT_URI` exactly in the Intuit app. For a sandbox, `http://localhost:8000/callback` is supported. Then create the connection and load a current token into your shell:

```bash
npm run auth
eval "$(npm run token --silent)"
```

`npm run auth` opens the Intuit consent screen and stores the refresh token plus `realmId` in `.env`. `npm run token` refreshes the access token, atomically persists any rotated refresh token, and exports only `QBO_ACCESS_TOKEN`, `QBO_REALM_ID`, and `QBO_ENVIRONMENT`.

### Legacy local stdio integration

This mode runs the OAuth-capable process locally and passes long-lived credentials to that local subprocess. Use the Streamable HTTP configuration below for the stateless relay.

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["path/to/mcp-quickbooks-online/dist/index.js"],
      "env": {
        "QUICKBOOKS_CLIENT_ID": "your_client_id",
        "QUICKBOOKS_CLIENT_SECRET": "your_client_secret",
        "QUICKBOOKS_REFRESH_TOKEN": "your_refresh_token",
        "QUICKBOOKS_REALM_ID": "your_realm_id",
        "QUICKBOOKS_ENVIRONMENT": "sandbox",
        "QUICKBOOKS_DISABLE_WRITE": "false",
        "QUICKBOOKS_DISABLE_UPDATE": "false",
        "QUICKBOOKS_DISABLE_DELETE": "false"
      }
    }
  }
}
```

Set any of the `DISABLE_*` flags to `"true"` to prevent that category of tools from being registered. Read tools (`get_*`, `search_*`) are always available.

For Streamable HTTP, start Codex from the shell where the three `QBO_*` variables were exported. Add the base MCP entry:

```bash
codex mcp add quickbooks \
  --url http://localhost:3000/mcp \
  --bearer-token-env-var QBO_ACCESS_TOKEN
```

Then add `env_http_headers` to the generated entry in `~/.codex/config.toml`:

```toml
[mcp_servers.quickbooks]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "QBO_ACCESS_TOKEN"
env_http_headers = { "X-QuickBooks-Realm-ID" = "QBO_REALM_ID", "X-QuickBooks-Environment" = "QBO_ENVIRONMENT" }
```

Codex reads these environment variables when it starts. After refreshing the token, restart or reconnect the MCP client so it picks up the new value. Do not run `codex mcp login`; this server intentionally does not publish MCP OAuth or DCR endpoints.

### HTTP Transport

The HTTP process exposes `/mcp` and `/health`. Every MCP request must include:

```http
Authorization: Bearer <quickbooks-access-token>
X-QuickBooks-Realm-ID: <quickbooks-company-id>
X-QuickBooks-Environment: sandbox
```

`X-QuickBooks-Environment` is optional and defaults to `QUICKBOOKS_DEFAULT_ENVIRONMENT`. The server creates a request-scoped QuickBooks client, forwards the call, and stores nothing. It never receives or refreshes the Intuit client secret or refresh token.

Run directly:

```bash
npm run build
npm run http
```

Or with Docker:

```bash
docker build -t qbo-mcp-server:local .
docker run --rm -p 127.0.0.1:3005:3000 \
  -e QUICKBOOKS_DEFAULT_ENVIRONMENT=sandbox \
  qbo-mcp-server:local
```

Or use Docker Compose:

```bash
docker compose up --build -d
docker compose ps
```

Compose reads port and feature settings from `.env`, but does not pass the Intuit client ID, client secret, refresh token, or realm ID into the container. It binds to `MCP_HOST_IP=127.0.0.1` by default and includes a `/health` health check.

Verify the transport with the current shell credentials:

```bash
curl http://localhost:3005/health

curl http://localhost:3005/mcp \
  -H "Authorization: Bearer $QBO_ACCESS_TOKEN" \
  -H "X-QuickBooks-Realm-ID: $QBO_REALM_ID" \
  -H "X-QuickBooks-Environment: $QBO_ENVIRONMENT" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

This is private BYO-token passthrough, not MCP OAuth. Use HTTPS for any non-loopback deployment because the header contains a live QuickBooks access token.

---

## Available Tools

### Entities

Complete CRUD operations are available for all entity types:

| Entity             | Create | Get | Update | Delete | Search |
| ------------------ | :----: | :-: | :----: | :----: | :----: |
| **Customer**       |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Invoice**        |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Estimate**       |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Bill**           |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Vendor**         |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Employee**       |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Account**        |   ✅   | ✅  |   ✅   |   -    |   ✅   |
| **Item**           |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Journal Entry**  |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Bill Payment**   |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Purchase**       |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Payment**        |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Sales Receipt**  |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Credit Memo**    |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Refund Receipt** |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Purchase Order** |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Vendor Credit**  |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Deposit**        |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Transfer**       |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Time Activity**  |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |
| **Class**          |   ✅   | ✅  |   ✅   |   -    |   ✅   |
| **Department**     |   ✅   | ✅  |   ✅   |   -    |   ✅   |
| **Term**           |   ✅   | ✅  |   ✅   |   -    |   ✅   |
| **Payment Method** |   ✅   | ✅  |   ✅   |   -    |   ✅   |
| **Tax Code**       |   -    | ✅  |   -    |   -    |   ✅   |
| **Tax Rate**       |   -    | ✅  |   -    |   -    |   ✅   |
| **Tax Agency**     |   -    | ✅  |   -    |   -    |   ✅   |
| **Company Info**   |   -    | ✅  |   ✅   |   -    |   -    |
| **Attachable**     |   ✅   | ✅  |   ✅   |   ✅   |   ✅   |

### Reports

| Report                      | Tool Name                     | Description                              |
| --------------------------- | ----------------------------- | ---------------------------------------- |
| **Balance Sheet**           | `get_balance_sheet`           | Assets, liabilities, and equity snapshot |
| **Profit & Loss**           | `get_profit_and_loss`         | Income and expenses over a period        |
| **Cash Flow**               | `get_cash_flow`               | Cash inflows and outflows                |
| **Trial Balance**           | `get_trial_balance`           | Debit and credit balances                |
| **General Ledger**          | `get_general_ledger`          | Complete transaction history             |
| **Customer Sales**          | `get_customer_sales`          | Sales by customer                        |
| **Aged Receivables**        | `get_aged_receivables`        | Outstanding customer invoices            |
| **Aged Receivables Detail** | `get_aged_receivables_detail` | Detailed aging breakdown                 |
| **Customer Balance**        | `get_customer_balance`        | Current customer balances                |
| **Aged Payables**           | `get_aged_payables`           | Outstanding vendor bills                 |
| **Vendor Expenses**         | `get_vendor_expenses`         | Expenses by vendor                       |

---

## Tool Reference

<details>
<summary><strong>Customer Tools</strong></summary>

| Tool               | Description                   |
| ------------------ | ----------------------------- |
| `create_customer`  | Create a new customer         |
| `get_customer`     | Get customer by ID            |
| `update_customer`  | Update customer details       |
| `delete_customer`  | Delete a customer             |
| `search_customers` | Search customers with filters |

</details>

<details>
<summary><strong>Invoice Tools</strong></summary>

| Tool              | Description                  |
| ----------------- | ---------------------------- |
| `create_invoice`  | Create a new invoice         |
| `get_invoice`     | Get invoice by ID            |
| `update_invoice`  | Update invoice details       |
| `delete_invoice`  | Delete/void an invoice       |
| `search_invoices` | Search invoices with filters |

</details>

<details>
<summary><strong>Payment Tools</strong></summary>

| Tool              | Description                  |
| ----------------- | ---------------------------- |
| `create_payment`  | Record a customer payment    |
| `get_payment`     | Get payment by ID            |
| `update_payment`  | Update payment details       |
| `delete_payment`  | Void a payment               |
| `search_payments` | Search payments with filters |

</details>

<details>
<summary><strong>Bill & Vendor Tools</strong></summary>

| Tool                   | Description                 |
| ---------------------- | --------------------------- |
| `create_bill`          | Create a new bill           |
| `get_bill`             | Get bill by ID              |
| `update_bill`          | Update bill details         |
| `delete_bill`          | Delete a bill               |
| `search_bills`         | Search bills with filters   |
| `create_vendor`        | Create a new vendor         |
| `get_vendor`           | Get vendor by ID            |
| `update_vendor`        | Update vendor details       |
| `delete_vendor`        | Delete a vendor             |
| `search_vendors`       | Search vendors with filters |
| `create_bill_payment`  | Create a bill payment       |
| `get_bill_payment`     | Get bill payment by ID      |
| `update_bill_payment`  | Update bill payment         |
| `delete_bill_payment`  | Delete a bill payment       |
| `search_bill_payments` | Search bill payments        |

</details>

<details>
<summary><strong>Sales Receipt & Credit Memo Tools</strong></summary>

| Tool                     | Description              |
| ------------------------ | ------------------------ |
| `create_sales_receipt`   | Create a sales receipt   |
| `get_sales_receipt`      | Get sales receipt by ID  |
| `update_sales_receipt`   | Update sales receipt     |
| `delete_sales_receipt`   | Void a sales receipt     |
| `search_sales_receipts`  | Search sales receipts    |
| `create_credit_memo`     | Create a credit memo     |
| `get_credit_memo`        | Get credit memo by ID    |
| `update_credit_memo`     | Update credit memo       |
| `delete_credit_memo`     | Void a credit memo       |
| `search_credit_memos`    | Search credit memos      |
| `create_refund_receipt`  | Create a refund receipt  |
| `get_refund_receipt`     | Get refund receipt by ID |
| `update_refund_receipt`  | Update refund receipt    |
| `delete_refund_receipt`  | Void a refund receipt    |
| `search_refund_receipts` | Search refund receipts   |

</details>

<details>
<summary><strong>Banking Tools</strong></summary>

| Tool               | Description                |
| ------------------ | -------------------------- |
| `create_deposit`   | Create a bank deposit      |
| `get_deposit`      | Get deposit by ID          |
| `update_deposit`   | Update deposit details     |
| `delete_deposit`   | Delete a deposit           |
| `search_deposits`  | Search deposits            |
| `create_transfer`  | Create an account transfer |
| `get_transfer`     | Get transfer by ID         |
| `update_transfer`  | Update transfer details    |
| `delete_transfer`  | Delete a transfer          |
| `search_transfers` | Search transfers           |

</details>

<details>
<summary><strong>Purchase Order & Vendor Credit Tools</strong></summary>

| Tool                     | Description              |
| ------------------------ | ------------------------ |
| `create_purchase_order`  | Create a purchase order  |
| `get_purchase_order`     | Get purchase order by ID |
| `update_purchase_order`  | Update purchase order    |
| `delete_purchase_order`  | Delete a purchase order  |
| `search_purchase_orders` | Search purchase orders   |
| `create_vendor_credit`   | Create a vendor credit   |
| `get_vendor_credit`      | Get vendor credit by ID  |
| `update_vendor_credit`   | Update vendor credit     |
| `delete_vendor_credit`   | Delete a vendor credit   |
| `search_vendor_credits`  | Search vendor credits    |

</details>

<details>
<summary><strong>Time Tracking Tools</strong></summary>

| Tool                     | Description             |
| ------------------------ | ----------------------- |
| `create_time_activity`   | Create a time activity  |
| `get_time_activity`      | Get time activity by ID |
| `update_time_activity`   | Update time activity    |
| `delete_time_activity`   | Delete a time activity  |
| `search_time_activities` | Search time activities  |

</details>

<details>
<summary><strong>Classification Tools</strong></summary>

| Tool                 | Description          |
| -------------------- | -------------------- |
| `create_class`       | Create a class       |
| `get_class`          | Get class by ID      |
| `update_class`       | Update class details |
| `search_classes`     | Search classes       |
| `create_department`  | Create a department  |
| `get_department`     | Get department by ID |
| `update_department`  | Update department    |
| `search_departments` | Search departments   |

</details>

<details>
<summary><strong>Settings Tools</strong></summary>

| Tool                     | Description              |
| ------------------------ | ------------------------ |
| `create_term`            | Create a payment term    |
| `get_term`               | Get term by ID           |
| `update_term`            | Update term details      |
| `search_terms`           | Search terms             |
| `create_payment_method`  | Create a payment method  |
| `get_payment_method`     | Get payment method by ID |
| `update_payment_method`  | Update payment method    |
| `search_payment_methods` | Search payment methods   |

</details>

<details>
<summary><strong>Tax Tools</strong></summary>

| Tool                  | Description          |
| --------------------- | -------------------- |
| `get_tax_code`        | Get tax code by ID   |
| `search_tax_codes`    | Search tax codes     |
| `get_tax_rate`        | Get tax rate by ID   |
| `search_tax_rates`    | Search tax rates     |
| `get_tax_agency`      | Get tax agency by ID |
| `search_tax_agencies` | Search tax agencies  |

</details>

<details>
<summary><strong>Company & Attachments</strong></summary>

| Tool                  | Description             |
| --------------------- | ----------------------- |
| `get_company_info`    | Get company information |
| `update_company_info` | Update company info     |
| `create_attachable`   | Create an attachment    |
| `get_attachable`      | Get attachment by ID    |
| `update_attachable`   | Update attachment       |
| `delete_attachable`   | Delete an attachment    |
| `search_attachables`  | Search attachments      |

</details>

---

## Authentication

Intuit OAuth runs entirely on the caller side. The MCP HTTP server has no callback, client ID, client secret, refresh token, token store, or OAuth state. The included local helper creates and refreshes the tokens that Codex sends to the MCP endpoint.

Create an app in the [Intuit Developer Portal](https://developer.intuit.com/) and follow [Intuit's OAuth 2.0 setup](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) to connect it to either a **sandbox** or a **production** QuickBooks Online company.

### Important: Sandbox vs Production

| Mode           | When to use                 | Redirect URI accepted                                       | Setup difficulty |
| -------------- | --------------------------- | ----------------------------------------------------------- | ---------------- |
| **Sandbox**    | Development, testing, demos | `http://localhost:8000/callback`                            | Easy             |
| **Production** | Real company data           | Public HTTPS callback, such as an ngrok tunnel to port 8000 | Requires HTTPS   |

If you only want to read your own company's data, you still need to set up an app — Intuit does not offer per-user API keys. There is no shortcut around the OAuth + app-creation flow.

### Sandbox Setup (recommended for first run)

1. Create a QuickBooks Online Accounting app in the Intuit Developer Portal.
2. Under the development redirect URIs, register `http://localhost:8000/callback` exactly.
3. Put the app's development client ID and secret in `.env`.
4. Set `QUICKBOOKS_ENVIRONMENT=sandbox` and `QUICKBOOKS_REDIRECT_URI=http://localhost:8000/callback`.
5. Run `npm run build`, then `npm run auth`.
6. On the Intuit consent screen, select the sandbox company and approve access. The helper writes `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID` to `.env`.
7. Run `eval "$(npm run token --silent)"` before starting Codex.

### Production Setup

[Production redirect URIs](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri) must use HTTPS and cannot use an IP address. A local tunnel can forward the callback to the helper:

```bash
ngrok http http://127.0.0.1:8000
```

Register `https://<id>.ngrok-free.app/callback` in the Intuit production settings, then configure:

```env
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://<id>.ngrok-free.app/callback
```

Keep the tunnel running during `npm run auth`. The same redirect URI is used for the authorization request and code exchange. Day-to-day token refresh does not require the callback or consent screen.

### Refreshing the Codex token

```bash
eval "$(npm run token --silent)"
codex
```

[QuickBooks access tokens expire after 60 minutes](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq). `npm run token` uses the locally stored refresh token to obtain a new access token and saves the newest refresh token returned by Intuit. Restart or reconnect Codex after refreshing because the MCP configuration reads `QBO_ACCESS_TOKEN` from the Codex process environment.

Use one refresh-token owner at a time. Concurrent refreshers can race when Intuit rotates the refresh token. If the refresh token is revoked, idle for too long, or otherwise rejected, clear `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID` in `.env` and run `npm run auth` to show the consent screen again.

### Common pitfalls

- **Redirect URI mismatch.** The URI registered in Intuit must match `QUICKBOOKS_REDIRECT_URI` exactly, including protocol, host, port, and `/callback` path.
- **Stale access token.** Refresh locally and restart or reconnect the MCP client; the HTTP server cannot refresh on the caller's behalf.
- **Leaking long-lived credentials.** Never put the client secret or refresh token in Codex headers or Docker environment variables. Only send the current access token, realm ID, and environment.
- **Wrong company.** `realmId` identifies the company selected on the Intuit consent screen. Reauthorize to switch companies.

---

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

The test suite includes focused coverage for the local Intuit OAuth callback, refresh-token rotation, stateless HTTP credential headers, request scoping, and QuickBooks token handling.

### Project Structure

```
src/
├── clients/          # QuickBooks API client
├── handlers/         # Business logic handlers (87 files)
├── tools/           # MCP tool definitions
├── helpers/         # Utility functions
├── types/           # TypeScript types
└── index.ts         # Server entry point

tests/
├── unit/            # Unit tests (396 tests)
│   ├── handlers/    # Handler tests (15 test files)
│   └── helpers/     # Helper tests
└── mocks/           # Test mocks

docs/
├── ARCHITECTURE.md  # System architecture & design patterns
├── TESTING.md       # Testing guide & patterns
└── plans/           # Development plans
```

---

## Documentation

| Document                                     | Description                                         |
| -------------------------------------------- | --------------------------------------------------- |
| [CHANGELOG.md](CHANGELOG.md)                 | Version history and all changes                     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, patterns, and design decisions |
| [docs/TESTING.md](docs/TESTING.md)           | Testing strategy, ESM patterns, and coverage guide  |

---

## Error Handling

If you encounter connection errors:

1. Verify all environment variables are set correctly
2. Check that tokens are valid and not expired
3. Ensure the QuickBooks app has the correct redirect URIs
4. For sandbox testing, use `QUICKBOOKS_ENVIRONMENT=sandbox`

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Tool naming convention

All tool names must follow the `{verb}_{entity}` convention using underscores. The verb prefix determines CRUD Restriction Mode behaviour:

| Prefix                     | Category | Suppressed by                    |
| -------------------------- | -------- | -------------------------------- |
| `create_`                  | WRITE    | `QUICKBOOKS_DISABLE_WRITE=true`  |
| `update_`                  | UPDATE   | `QUICKBOOKS_DISABLE_UPDATE=true` |
| `delete_`                  | DELETE   | `QUICKBOOKS_DISABLE_DELETE=true` |
| `get_`, `search_`, `read_` | READ     | never                            |

New tools that do not follow this convention will not be correctly categorised and may appear or be suppressed unexpectedly.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- Based on [Intuit's QuickBooks Online MCP Server](https://github.com/intuit/quickbooks-online-mcp-server)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
