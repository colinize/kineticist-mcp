#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createKineticistMCPServer } from "./server.js";

const apiBaseUrl = process.env.KINETICIST_API_URL;
const apiKey = process.env.KINETICIST_API_KEY ?? "";

if (!apiKey) {
  console.error(
    "KINETICIST_API_KEY is required. Get one at https://www.kineticist.com/settings",
  );
  process.exit(1);
}

// serveStdio answers both the 2025 initialize handshake and 2026-07-28 clients.
serveStdio(() =>
  createKineticistMCPServer({
    apiKey,
    apiBaseUrl,
  }),
);
