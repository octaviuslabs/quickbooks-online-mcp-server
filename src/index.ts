#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createQboMcpServer } from "./server/create-server.js";

const main = async () => {
  // Create an MCP server with every QuickBooks tool registered
  const server = createQboMcpServer();

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
