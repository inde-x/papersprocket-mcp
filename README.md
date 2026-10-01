# PaperSprocket MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that
gives MCP clients direct access to the **PaperSprocket** API. It exposes
**exactly two tools**:

| Tool | Description |
|------|-------------|
| `render_html_to_pdf(html, page?)` | Render HTML to a PDF through the PaperSprocket API. Returns the PDF as an `application/pdf` MCP resource (base64 blob), a local file path when the server can write one, and render metadata (`render_id`, `page_count`, `charged_cents`, `balance_cents`). Billed to the configured account. |
| `check_balance(account_id)` | Read the prepaid balance of the configured PaperSprocket account. Returns `account_id`, `balance_cents`, `currency`, and `page_price_cents`. |

This is a minimal native MCP server built directly on
`@modelcontextprotocol/sdk`. No top-up tools, no API-key-management tools —
just render and balance-check.

## What is PaperSprocket?

PaperSprocket is a hosted API that turns HTML into PDFs. You send it HTML, it
returns a well-formed PDF. There is no business-field schema to learn: you
control the layout with your own HTML and CSS, PaperSprocket handles the PDF
processing. See the official [documentation](https://papersprocket.com/docs).

## Requirements

- Node.js >= 20
- A PaperSprocket API key. The server reads it from **server-side config
  only** (environment or `.env`) — it is **never** a caller-supplied tool
  argument, and is never embedded in source, examples, or this document.

## Install

```bash
git clone https://github.com/inde-x/papersprocket-mcp.git
cd papersprocket-mcp
npm ci
cp .env.example .env   # then set PAPERSPROCKET_API_KEY (see Configuration)
```

## Configuration

The server loads `<serverdir>/.env` at startup (it does not override
already-set environment variables). `.env` is gitignored.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PAPERSPROCKET_API_KEY` | **yes** | — | Your PaperSprocket API key. Secret/config state — never a tool argument. |
| `PAPERSPROCKET_BASE_URL` | no | `https://papersprocket.com/api` | API base URL. Fixed/config state. |
| `PAPERSPROCKET_MCP_OUTPUT_DIR` | no | `./output` | Directory where rendered PDFs are also written (best-effort) for filesystem-local clients. |

Example `.env` (replace the placeholder — never commit a real key):

```bash
PAPERSPROCKET_API_KEY=psk_your_api_key_here
# PAPERSPROCKET_BASE_URL=https://papersprocket.com/api
# PAPERSPROCKET_MCP_OUTPUT_DIR=./output
```

## Run (stdio)

```bash
node server.js                 # MCP over stdio
node server.js --list-tools    # print tool schemas, then exit
```

### Connect an MCP client

Point your MCP client at a stdio server (this example uses a generic path):

```
Command:   node
Arguments: /path/to/papersprocket-mcp/server.js
```

`PAPERSPROCKET_API_KEY` is provided via the server `.env` or environment —
never in the client configuration.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector node /path/to/papersprocket-mcp/server.js
```

List tools → confirm exactly two: `render_html_to_pdf` and `check_balance`.

## Tool schemas

### `render_html_to_pdf`

```json
{
  "html": { "type": "string", "description": "HTML to render (non-empty)." },
  "page": {
    "properties": {
      "size":            { "enum": ["A4", "Letter"] },
      "orientation":     { "enum": ["portrait", "landscape"] },
      "margin_mm":       { "top|right|bottom|left": { "type": "number", "minimum": 0, "maximum": 50 } },
      "print_background": { "type": "boolean" }
    }
  }
}
```

- `html` — required, non-empty string.
- `page` — optional. Defaults mirror the service's closed v1 schema: `size`
  `A4`, `orientation` `portrait`, `margin_mm` `10` on all sides,
  `print_background` `true`. Unknown fields are rejected.

**Result** (two MCP content blocks):

1. `text` — metadata JSON: `tool`, `format`, `render_id`, `page_count`,
   `charged_cents`, `balance_cents`, `bytes`, `file_path`, `idempotency_key`.
2. `resource` — `application/pdf` blob (base64) with a `file://` (or `urn:`)
   URI.

### `check_balance`

```json
{ "account_id": { "type": "string" } }
```

- `account_id` — required, non-empty string.

**Result:** `{ account_id, balance_cents, currency, page_price_cents }`
(text block).

## Idempotency

- A **fresh random idempotency key** is generated for each logical render.
- On a transient network failure the server retries up to 2× **reusing the
  same key**, so a retry of one logical render cannot double-charge.
- Server-side, PaperSprocket dedupes on `(Idempotency-Key, request hash)`, so a
  true replay returns the original result without a second debit.

## Security / secret boundary

- `PAPERSPROCKET_API_KEY` is read from `.env` / environment — it is **not** a
  field in any tool input schema.
- `PAPERSPROCKET_BASE_URL` is fixed/config state, not an agent-controlled
  argument.
- The key is sent only as the `Authorization` HTTP header. No other
  credentials exist.
- Rendered PDFs written to `output/` are your own content; the directory is
  gitignored.

## Pricing

- **$10** initial prepaid credit
- **$10** top-ups
- **$0.02 / page**

## Getting a key

Create a PaperSprocket account to get your API key and prepaid credit:

- Onboarding: https://papersprocket.com/onboarding/?source=mcp

## License

MIT — see [LICENSE](LICENSE).