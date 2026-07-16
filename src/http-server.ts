#!/usr/bin/env node

import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";
import { createQuickbooksMCPServer } from "./index.js";
import {
  QuickbooksClient,
  runWithQuickbooksClient,
} from "./clients/quickbooks-client.js";

export const QUICKBOOKS_REALM_HEADER = "x-quickbooks-realm-id";
export const QUICKBOOKS_ENVIRONMENT_HEADER = "x-quickbooks-environment";

export type QuickBooksHttpServerConfig = {
  corsOrigin: string;
  defaultQuickbooksEnvironment: "sandbox" | "production";
};

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 8 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HTTP_ENV_ALLOWLIST = new Set([
  "MCP_HTTP_PORT",
  "PORT",
  "MCP_CORS_ORIGIN",
  "QUICKBOOKS_DEFAULT_ENVIRONMENT",
  "QUICKBOOKS_DISABLE_WRITE",
  "QUICKBOOKS_DISABLE_UPDATE",
  "QUICKBOOKS_DISABLE_DELETE",
]);

function loadHttpEnv(): void {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [name, value] of Object.entries(parsed)) {
    if (!HTTP_ENV_ALLOWLIST.has(name) || process.env[name] !== undefined)
      continue;
    process.env[name] = value;
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadHttpServerConfig(env: NodeJS.ProcessEnv = process.env): {
  port: number;
  config: QuickBooksHttpServerConfig;
} {
  const port = parseInteger(
    env.MCP_HTTP_PORT,
    parseInteger(env.PORT, DEFAULT_PORT),
  );
  const environment = env.QUICKBOOKS_DEFAULT_ENVIRONMENT?.trim() || "sandbox";
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      "QUICKBOOKS_DEFAULT_ENVIRONMENT must be sandbox or production",
    );
  }

  return {
    port,
    config: {
      corsOrigin: env.MCP_CORS_ORIGIN?.trim() || "*",
      defaultQuickbooksEnvironment: environment,
    },
  };
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function readBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer[ \t]+([^ \t]+)[ \t]*$/i);
  return match?.[1];
}

function setCommonHeaders(res: ServerResponse, corsOrigin: string): void {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Authorization",
      "Content-Type",
      "Last-Event-ID",
      "MCP-Protocol-Version",
      "MCP-Session-ID",
      "X-QuickBooks-Realm-ID",
      "X-QuickBooks-Environment",
    ].join(", "),
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-ID");
}

function sendJson(
  res: ServerResponse,
  corsOrigin: string,
  statusCode: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  setCommonHeaders(res, corsOrigin);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendText(
  res: ServerResponse,
  corsOrigin: string,
  statusCode: number,
  body: string,
): void {
  if (res.headersSent) return;
  setCommonHeaders(res, corsOrigin);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBody = await readRawBody(req);
  if (!rawBody.trim()) return undefined;
  return JSON.parse(rawBody);
}

type RequestCredentials = {
  accessToken: string;
  realmId: string;
  environment: "sandbox" | "production";
};

function readRequestCredentials(
  req: IncomingMessage,
  config: QuickBooksHttpServerConfig,
): RequestCredentials | { status: number; error: string; description: string } {
  const accessToken = readBearerToken(getHeader(req, "authorization"));
  if (!accessToken) {
    return {
      status: 401,
      error: "missing_quickbooks_access_token",
      description:
        "Send the current QuickBooks access token as Authorization: Bearer <token>",
    };
  }
  if (Buffer.byteLength(accessToken, "utf8") > MAX_ACCESS_TOKEN_BYTES) {
    return {
      status: 400,
      error: "invalid_quickbooks_access_token",
      description: "The QuickBooks access token is too large",
    };
  }

  const realmId = getHeader(req, QUICKBOOKS_REALM_HEADER)?.trim();
  if (!realmId) {
    return {
      status: 400,
      error: "missing_quickbooks_realm_id",
      description: "Send the QuickBooks company ID in X-QuickBooks-Realm-ID",
    };
  }
  if (!/^\d{1,32}$/.test(realmId)) {
    return {
      status: 400,
      error: "invalid_quickbooks_realm_id",
      description: "X-QuickBooks-Realm-ID must contain 1 to 32 digits",
    };
  }

  const environment =
    getHeader(req, QUICKBOOKS_ENVIRONMENT_HEADER)?.trim() ||
    config.defaultQuickbooksEnvironment;
  if (environment !== "sandbox" && environment !== "production") {
    return {
      status: 400,
      error: "invalid_quickbooks_environment",
      description:
        "X-QuickBooks-Environment must be sandbox or production when provided",
    };
  }

  return { accessToken, realmId, environment };
}

export function createQuickBooksHttpServer(
  config: QuickBooksHttpServerConfig,
): http.Server {
  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const credentials = readRequestCredentials(req, config);
    if ("error" in credentials) {
      if (credentials.status === 401) {
        res.setHeader(
          "WWW-Authenticate",
          'Bearer realm="quickbooks", error="invalid_token"',
        );
      }
      sendJson(res, config.corsOrigin, credentials.status, {
        error: credentials.error,
        error_description: credentials.description,
        requiredHeaders: [
          "Authorization: Bearer <QuickBooks access token>",
          "X-QuickBooks-Realm-ID: <QuickBooks company ID>",
        ],
        optionalHeaders: ["X-QuickBooks-Environment: sandbox|production"],
      });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch (error) {
      sendJson(res, config.corsOrigin, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message:
            error instanceof SyntaxError
              ? "Parse error"
              : "Invalid request body",
        },
        id: null,
      });
      return;
    }

    const quickbooksClient = new QuickbooksClient({
      accessToken: credentials.accessToken,
      realmId: credentials.realmId,
      environment: credentials.environment,
      allowInteractiveAuth: false,
      persistTokensToEnv: false,
    });
    const mcpServer = createQuickbooksMCPServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.once("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    await runWithQuickbooksClient(quickbooksClient, async () => {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody as any);
    });
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    setCommonHeaders(res, config.corsOrigin);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");
    const method = req.method || "";

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, config.corsOrigin, 200, {
        ok: true,
        auth: "caller-supplied-quickbooks-token",
        requiredHeaders: ["Authorization", "X-QuickBooks-Realm-ID"],
        optionalHeaders: ["X-QuickBooks-Environment"],
        defaultQuickbooksEnvironment: config.defaultQuickbooksEnvironment,
      });
      return;
    }

    if (url.pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(method)) {
      await handleMcpRequest(req, res);
      return;
    }

    sendText(res, config.corsOrigin, 404, "Not found");
  }

  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error("[http-server] request failed:", error);
      sendJson(res, config.corsOrigin, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    });
  });
}

async function main(): Promise<void> {
  loadHttpEnv();
  const { port, config } = loadHttpServerConfig();
  const server = createQuickBooksHttpServer(config);

  server.listen(port, () => {
    console.error(`QuickBooks MCP HTTP server listening on port ${port}`);
    console.error(
      "Authentication: caller-supplied QuickBooks bearer token and realm ID",
    );
  });

  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(
      "[http-server] startup failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
