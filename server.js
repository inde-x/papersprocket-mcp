#!/usr/bin/env node
/**
 * PaperSprocket-native MCP server (stdio).
 *
 * Exactly two tools:
 *   - render_html_to_pdf(html, page?)   → POST /v1/render   → binary PDF
 *   - check_balance(account_id)          → GET  /v1/accounts/:id/balance → structured result
 *
 * CONFIG / SECRET BOUNDARY
 *   - API key comes from server-side config only: PAPERSPROCKET_API_KEY
 *     (env or <serverdir>/.env). It is NEVER a caller-supplied tool argument,
 *     never embedded in source/package/examples/logs.
 *   - base_url comes from PAPERSPROCKET_BASE_URL (default production API). It is
 *     fixed/config state, not an agent-controlled argument.
 *
 * Binary PDF handling:
 *   A naive text coercion of the HTTP response would destroy the binary PDF.
 *   This server reads the raw PDF bytes directly and returns them as an MCP
 *   EmbeddedResource (blob) plus file + metadata, which is the MCP-appropriate
 *   binary handling.
 *
 * Idempotency design:
 *   - A fresh random idempotency key is generated per logical render.
 *   - Within one invocation, transient network failures retry with the SAME key,
 *     so a retry of one logical render cannot double-charge.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Config loading (secret-aware, fail-closed)
 * ------------------------------------------------------------------ */
function loadEnv(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* .env optional */
  }
}

// Load <serverdir>/.env into the runtime env (does not override existing env).
// (.env* is gitignored; only .env.example is tracked — no secrets in the repo.)
loadEnv(path.join(__dirname, ".env"));

function config() {
  const apiKey = process.env.PAPERSPROCKET_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      "PAPERSPROCKET_API_KEY is required (set it in the server .env or environment). " +
        "It is secret/config state and must never be passed as a tool argument.",
    );
  }
  const baseUrl = (process.env.PAPERSPROCKET_BASE_URL || "https://papersprocket.com/api").replace(/\/+$/, "");
  const outputDir = process.env.PAPERSPROCKET_MCP_OUTPUT_DIR || path.join(__dirname, "output");
  return { apiKey, baseUrl, outputDir };
}

/* ------------------------------------------------------------------ *
 * Render body schema
 * ------------------------------------------------------------------ */
const PAGE_SIZES = ["A4", "Letter"];
const ORIENTATIONS = ["portrait", "landscape"];
const MIN_MARGIN_MM = 0;
const MAX_MARGIN_MM = 50;
const MARGIN_SIDES = ["top", "right", "bottom", "left"];

// eslint-disable-next-line no-unused-vars
const PAGE_SCHEMA = {
  type: "object",
  properties: {
    size: { type: "string", enum: PAGE_SIZES, description: "Paper size. Default A4." },
    orientation: { type: "string", enum: ORIENTATIONS, description: "Portrait or landscape. Default portrait." },
    margin_mm: {
      type: "object",
      properties: {
        top: { type: "number", minimum: MIN_MARGIN_MM, maximum: MAX_MARGIN_MM },
        right: { type: "number", minimum: MIN_MARGIN_MM, maximum: MAX_MARGIN_MM },
        bottom: { type: "number", minimum: MIN_MARGIN_MM, maximum: MAX_MARGIN_MM },
        left: { type: "number", minimum: MIN_MARGIN_MM, maximum: MAX_MARGIN_MM },
      },
      additionalProperties: false,
      description: "Page margins in millimetres (0–50). Default 10 on all sides.",
    },
    print_background: {
      type: "boolean",
      description: "Print CSS background colors. Default true.",
    },
  },
  additionalProperties: false,
};

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate + materialize the caller-supplied `page` object to the service's
 * closed v1 schema, so the MCP tool surfaces the same accepted values as the
 * live API and rejects the same invalid ones.
 */
function normalizePage(pageIn) {
  const raw = pageIn === undefined ? {} : pageIn;
  if (!isPlainObject(raw)) throw new McpError(ErrorCode.InvalidParams, "page must be an object");
  const allowed = new Set(["size", "orientation", "margin_mm", "print_background"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new McpError(ErrorCode.InvalidParams, `unknown page field '${k}'`);
  }
  const page = {
    size: raw.size === undefined ? "A4" : raw.size,
    orientation: raw.orientation === undefined ? "portrait" : raw.orientation,
    print_background: raw.print_background === undefined ? true : raw.print_background,
    margin_mm: {},
  };
  if (!PAGE_SIZES.includes(page.size)) {
    throw new McpError(ErrorCode.InvalidParams, "page.size must be 'A4' or 'Letter'");
  }
  if (!ORIENTATIONS.includes(page.orientation)) {
    throw new McpError(ErrorCode.InvalidParams, "page.orientation must be 'portrait' or 'landscape'");
  }
  if (typeof page.print_background !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, "page.print_background must be a boolean");
  }
  const m = raw.margin_mm === undefined ? MARGIN_SIDES.reduce((o, s) => ((o[s] = 10), o), {}) : raw.margin_mm;
  if (!isPlainObject(m)) throw new McpError(ErrorCode.InvalidParams, "page.margin_mm must be an object");
  for (const k of Object.keys(m)) {
    if (!MARGIN_SIDES.includes(k)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown margin_mm field '${k}'`);
    }
    const v = m[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_MARGIN_MM || v > MAX_MARGIN_MM) {
      throw new McpError(ErrorCode.InvalidParams, `page.margin_mm.${k} must be 0..${MAX_MARGIN_MM}`);
    }
  }
  for (const s of MARGIN_SIDES) {
    page.margin_mm[s] = m[s] !== undefined ? m[s] : 10;
  }
  return page;
}

/* ------------------------------------------------------------------ *
 * HTTP client
 * ------------------------------------------------------------------ */
async function httpJsonError(res, url) {
  let detail;
  try {
    const j = await res.json();
    detail = j.detail || j.error || JSON.stringify(j);
  } catch {
    detail = await res.text().catch(() => "");
  }
  const msg = `PaperSprocket API ${res.status} from ${url}: ${detail}`;
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

async function fetchWithRetry(url, options, { maxRetries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        // Transient network failure: retry with the SAME request + same idempotency
        // key (the caller passed options.headers.Idempotency-Key which we reuse).
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

/** Render a string of HTML to a PDF through the live PaperSprocket API. */
async function renderHtmlToPdf(args) {
  if (!isPlainObject(args)) {
    throw new McpError(ErrorCode.InvalidParams, "arguments must be an object");
  }
  const html = args.html;
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "html must be a non-empty string");
  }
  const page = normalizePage(args.page);
  const { apiKey, baseUrl, outputDir } = config();

  const body = { html };
  if (args.page !== undefined) body.page = page;

  // Fresh idempotency key for this logical render.
  const idempotencyKey = crypto.randomUUID();
  const url = `${baseUrl}/v1/render`;
  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  };

  let res;
  try {
    res = await fetchWithRetry(url, requestOptions);
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Render request failed after retries (network error, nothing billed): ${err.message}`,
    );
  }

  if (!res.ok) {
    const e = await httpJsonError(res, url);
    // Map service errors to MCP codes without leaking secrets.
    const code =
      res.status === 402 ? ErrorCode.InvalidParams
        : res.status === 401 || res.status === 403 ? ErrorCode.InvalidRequest
        : ErrorCode.InternalError;
    throw new McpError(code, e.message);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const meta = {
    render_id: res.headers.get("papersprocket-render-id") || undefined,
    page_count: res.headers.get("papersprocket-page-count") ?? undefined,
    charged_cents: res.headers.get("papersprocket-charged-cents") ?? undefined,
    balance_cents: res.headers.get("papersprocket-balance-cents") ?? undefined,
    bytes: buf.length,
  };

  // Persist the PDF to the configured output dir (best-effort) so clients with
  // local-filesystem access can consume it directly.
  let filePath;
  try {
    const id = meta.render_id || idempotencyKey;
    fs.mkdirSync(outputDir, { recursive: true });
    filePath = path.join(outputDir, `${id}.pdf`);
    fs.writeFileSync(filePath, buf);
  } catch (err) {
    // Non-fatal: the embedded resource below still carries the bytes.
    // (Do not log anything secret; this is just a path.)
    filePath = undefined;
  }

  const contentType = res.headers.get("content-type") || "application/pdf";

  return {
    metadata: {
      tool: "render_html_to_pdf",
      format: "application/pdf",
      ...meta,
      file_path: filePath,
      idempotency_key: idempotencyKey,
    },
    pdf: {
      uri: filePath ? `file://${filePath}` : `urn:papersprocket:render:${meta.render_id || idempotencyKey}`,
      mimeType: contentType,
      bytes: buf,
    },
  };
}

/** Read an account's prepaid balance through the live PaperSprocket API. */
async function checkBalance(args) {
  if (!isPlainObject(args)) {
    throw new McpError(ErrorCode.InvalidParams, "arguments must be an object");
  }
  const accountId = args.account_id;
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "account_id must be a non-empty string");
  }
  const { apiKey, baseUrl } = config();
  const url = `${baseUrl}/v1/accounts/${encodeURIComponent(accountId)}/balance`;

  let res;
  try {
    res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, `Balance request failed: ${err.message}`);
  }
  if (!res.ok) {
    const e = await httpJsonError(res, url);
    const code =
      res.status === 401 || res.status === 403 ? ErrorCode.InvalidRequest
        : res.status === 404 ? ErrorCode.InvalidParams
        : ErrorCode.InternalError;
    throw new McpError(code, e.message);
  }
  const j = await res.json();
  return {
    account_id: j.account_id,
    balance_cents: j.balance_cents,
    currency: j.currency,
    page_price_cents: j.page_price_cents,
  };
}

/* ------------------------------------------------------------------ *
 * MCP server
 * ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: "render_html_to_pdf",
    description:
      "Render HTML to a PDF through the PaperSprocket API. Returns the PDF as an " +
      "application/pdf embedded resource (base64 blob), the local file path when the " +
      "server can write it, and render metadata (render_id, page_count, charged_cents, " +
      "balance_cents). Billed to the configured PaperSprocket account.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML to render (non-empty)." },
        page: PAGE_SCHEMA,
      },
      required: ["html"],
    },
    run: renderHtmlToPdf,
  },
  {
    name: "check_balance",
    description:
      "Check the prepaid balance of the configured PaperSprocket account. " +
      "Returns account_id, balance_cents, currency, and page_price_cents.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "The PaperSprocket account id to query." },
      },
      required: ["account_id"],
    },
    run: checkBalance,
  },
];

function buildServer() {
  const server = new Server(
    { name: "papersprocket-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    const args = request.params.arguments ?? {};
    try {
      const result = await tool.run(args);
      const blocks = [];
      if (result.metadata) {
        blocks.push({ type: "text", text: JSON.stringify(result.metadata, null, 2) });
      }
      if (result.pdf) {
        blocks.push({
          type: "resource",
          resource: {
            uri: result.pdf.uri,
            mimeType: result.pdf.mimeType,
            blob: result.pdf.bytes.toString("base64"),
          },
        });
      }
      if (result.account_id !== undefined) {
        blocks.push({
          type: "text",
          text: JSON.stringify(
            {
              account_id: result.account_id,
              balance_cents: result.balance_cents,
              currency: result.currency,
              page_price_cents: result.page_price_cents,
            },
            null,
            2,
          ),
        });
      }
      return { content: blocks };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, err.message);
    }
  });

  return server;
}

/* -- CLI: --list-tools prints schemas without starting a session ----------- */
if (process.argv.includes("--list-tools")) {
  console.log(JSON.stringify(
    TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    null,
    2,
  ));
  process.exit(0);
}

// Export internals for testing, but only start the server when run directly
// (not when imported by a test harness).
export { config, normalizePage, renderHtmlToPdf, checkBalance, fetchWithRetry, TOOLS, buildServer };

const isDirect = import.meta.url === `file://${process.argv[1] ? path.resolve(process.argv[1]) : ""}` ||
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}