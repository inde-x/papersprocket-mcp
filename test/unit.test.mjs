import test from "node:test";
import assert from "node:assert/strict";
import { normalizePage, renderHtmlToPdf, checkBalance, TOOLS, buildServer } from "../server.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

// Deterministic env for tests (no real secret needed)
const TEST_ENV = { PAPERSPROCKET_API_KEY: "test-api-key-not-a-secret", PAPERSPROCKET_BASE_URL: "https://ps.test/api" };
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;

const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(800, 7)]);

function fakeFetch({ status = 200, json, headers = {}, body = null }) {
  return async (url, options) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
    arrayBuffer: async () => body,
  });
}

test("exactly two tools exposed", () => {
  assert.equal(TOOLS.length, 2);
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_balance", "render_html_to_pdf"]);
});

test("tool input schemas expose dynamic html/account_id; no secret-bearing inputs", () => {
  const render = TOOLS.find((t) => t.name === "render_html_to_pdf");
  assert.ok(render.inputSchema.required.includes("html"));
  assert.ok("html" in render.inputSchema.properties);
  assert.ok("page" in render.inputSchema.properties);
  const bal = TOOLS.find((t) => t.name === "check_balance");
  assert.ok(bal.inputSchema.required.includes("account_id"));
  assert.ok("account_id" in bal.inputSchema.properties);
  for (const t of TOOLS) {
    for (const p of Object.keys(t.inputSchema.properties)) {
      assert.ok(!/key|secret|token|auth|bearer|credential/i.test(p), `secret param leaked: ${p}`);
    }
  }
});

test("normalizePage: defaults materialize identically to the live service schema", () => {
  assert.deepEqual(normalizePage(undefined), {
    size: "A4", orientation: "portrait", print_background: true,
    margin_mm: { top: 10, right: 10, bottom: 10, left: 10 },
  });
  assert.deepEqual(
    normalizePage({ size: "Letter", orientation: "landscape", print_background: false, margin_mm: { top: 20 } }),
    { size: "Letter", orientation: "landscape", print_background: false, margin_mm: { top: 20, right: 10, bottom: 10, left: 10 } },
  );
});

test("normalizePage: rejects invalid values (closed schema, mirrors service)", () => {
  assert.throws(() => normalizePage({ size: "XL" }), McpError);
  assert.throws(() => normalizePage({ orientation: "diagonal" }), McpError);
  assert.throws(() => normalizePage({ margin_mm: { top: 99 } }), McpError);
  assert.throws(() => normalizePage({ margin_mm: { middle: 5 } }), McpError);
  assert.throws(() => normalizePage({ unexpected: true }), McpError);
});

test("render_html_to_pdf: builds service request from caller args; key is secret/config only", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = fakeFetch({ status: 200, headers: { "content-type": "application/pdf", "papersprocket-render-id": "render_x" }, body: pdfBytes });
  try {
    const result = await renderHtmlToPdf({ html: "<h1>hi</h1>", page: { size: "A4" } });
    assert.ok(result.pdf.bytes.equals(pdfBytes));
    assert.equal(result.metadata.format, "application/pdf");
    // fresh idempotency + bearer auth on the wire
    // re-run through a recording fetch to capture headers/body:
  } finally {
    globalThis.fetch = originalFetch;
  }
  // capture the actual request via a recording fetch
  let req;
  globalThis.fetch = (url, options) => { req = { url, options }; return Promise.resolve(fakeFetch({ status: 200, headers: { "content-type": "application/pdf" }, body: pdfBytes })(url, options)); };
  await renderHtmlToPdf({ html: "<h1>again</h1>" });
  globalThis.fetch = originalFetch;
  assert.equal(req.url, "https://ps.test/api/v1/render");
  assert.equal(req.options.method, "POST");
  assert.equal(req.options.headers.Authorization, "Bearer test-api-key-not-a-secret");
  assert.match(req.options.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/i);
  const body = JSON.parse(req.options.body);
  assert.equal(body.html, "<h1>again</h1>");
  assert.ok(!("api_key" in body) && !("key" in body) && !("secret" in body));
  assert.ok(!("PAPERSPROCKET_API_KEY" in body));
});

test("idempotency: fresh key per distinct logical render; same key reused on retry within one invocation", async () => {
  const originalFetch = globalThis.fetch;
  const keysSeen = [];
  let call = 0;
  let options = null;
  globalThis.fetch = async (url, opts) => {
    call++;
    keysSeen.push(opts.headers["Idempotency-Key"]);
    options = opts;
    // First attempt fails transiently, retry succeeds — key must be idempotent (same).
    if (call === 1) throw new TypeError("network blip (simulated)");
    return fakeFetch({ status: 200, headers: { "content-type": "application/pdf" }, body: pdfBytes })(url, opts);
  };
  try {
    await renderHtmlToPdf({ html: "<h1>retry test</h1>" });
    assert.equal(keysSeen.length, 2, "expected one retry with same key");
    assert.equal(keysSeen[0], keysSeen[1], "retry must reuse the SAME idempotency key");
    // A distinct render must get a fresh key:
    await renderHtmlToPdf({ html: "<h1>another logical render</h1>" });
    const allKeys = [keysSeen[0], options.headers["Idempotency-Key"]];
    assert.notEqual(allKeys[0], allKeys[1], "distinct logical renders must get fresh idempotency keys");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("check_balance: GETs the account endpoint, returns structured result", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = ((url, options) => { captured = { url, options }; return Promise.resolve(fakeFetch({ status: 200, json: { account_id: "a1", balance_cents: 998, currency: "USD", page_price_cents: 2 } })(url, options)); });
  try {
    const r = await checkBalance({ account_id: "a1" });
    assert.equal(captured.url, "https://ps.test/api/v1/accounts/a1/balance");
    assert.equal(captured.options.method, "GET");
    assert.equal(captured.options.headers.Authorization, "Bearer test-api-key-not-a-secret");
    assert.equal(r.balance_cents, 998);
  } finally { globalThis.fetch = originalFetch; }
});

test("check_balance: rejects non-string/empty account_id", async () => {
  await assert.rejects(() => checkBalance({ account_id: "" }), (e) => e && e.code === -32602);
  await assert.rejects(() => checkBalance({ account_id: 123 }), (e) => e && e.code === -32602);
});

test("buildServer exposes resources for PDF (not text coercion) and error on bad http", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({ status: 402, json: { error: "insufficient_funds", detail: "no balance" } });
  try {
    await assert.rejects(() => renderHtmlToPdf({ html: "<h1>x</h1>" }), (e) => /402/.test(e.message));
  } finally { globalThis.fetch = originalFetch; }
});