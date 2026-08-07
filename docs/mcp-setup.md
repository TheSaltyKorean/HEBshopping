# Connecting the MCP server

The server exposes four tools over stdio and works with any MCP client. Build first:

```bash
npm run build
```

It needs a session file:

```bash
npm run login           # a browser opens; log in by hand
npm run verify:session  # read-only check that the stored session works
```

New here? Start with [`setup.md`](setup.md), which covers install and both clients
step by step. This page is the reference for the MCP server specifically.

## Claude Code

Already configured — `.mcp.json` in the repo root registers the server for this project.
Start Claude Code here and approve it when prompted. Verify with `/mcp`.

## Gemini CLI

Add to `~/.gemini/settings.json`:

```jsonc
{
  "mcpServers": {
    "heb-shopping-list": {
      "command": "node",
      "args": ["/path/to/HEBshopping/packages/mcp-server/dist/stdio.js"],
      "env": {
        "HEB_SESSION_PATH": "/path/to/HEBshopping/.session/session.json"
      }
    }
  }
}
```

Absolute paths matter here: Gemini CLI does not launch the server from this directory.

## Gemini Spark

Spark takes an MCP **URL**, not a command, so it needs the deployed HTTP endpoint. It also
requires a Google AI Ultra subscription ($99.99/mo), US-only, and setup on the web app at
*Settings → Connected Apps → Custom apps for Spark*. The tools are identical to the stdio
ones — only the transport differs.

The endpoint is **off by default**, because a public URL you are not using is only an
attack surface. To turn it on:

**1.** Set `enable_mcp_url = true` in `infra/terraform.tfvars`, then deploy — see
[`deploy.md`](deploy.md).

**2.** Read the URL and the bearer token. The token is deliberately not a Terraform output,
since that would put it in plain text in state and in your scrollback:

```bash
terraform -chdir=infra output -raw mcp_url

aws ssm get-parameter --with-decryption \
  --name "$(terraform -chdir=infra output -raw mcp_token_parameter)" \
  --query Parameter.Value --output text
```

**3.** In Spark, add the URL as a custom app with an `Authorization: Bearer <token>`
header. Requests without it get a 401 — the check runs before anything is parsed.

Treat that token like the session file: anyone holding it can read and change your list.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HEB_SESSION_PATH` | `.session/session.json` (relative to CWD) | session cookie jar |
| `HEB_LIST_ID` | unset | pin one list; only needed if the account has several |

## Tools

| Tool | Writes? | Notes |
|---|---|---|
| `heb_read_list` | no | returns items with their `lineId` |
| `heb_search_product` | no | resolves free text to `productId`s |
| `heb_add_item` | **yes** | takes exactly one of `query`, `productId`, or `text`; optional `quantity` or `weight` |
| `heb_remove_item` | **yes** | takes exactly one of `lineId` or `item` |

A vague `heb_add_item({query})` **writes nothing** — it returns candidate products and asks
you to call again with a `productId`. That is deliberate: an unnecessary question costs two
seconds, whereas silently adding the wrong product costs a wasted trip.

Two extras worth knowing:

- **`text`** adds a plain written line, matched against nothing — the same thing H-E-B's
  own `Add "…" to list` button creates. Use it when the catalog genuinely has nothing
  (`PRODUCT_NOT_FOUND`) or the request is generic ("birthday candles").
- **`weight`** is pounds, for counter goods sold by the pound (deli meat and cheese sliced
  to order, seafood). It is rounded to the nearest weight H-E-B accepts — a quarter pound —
  and ignored for packaged goods, which are bought by the package. The reply says which
  happened: a weighted line reads `2 lb …`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `SESSION_EXPIRED` | cookies expired; re-run `npm run login`. Passkey/OTP mean only a human can do this. |
| Client disconnects immediately | the server wasn't built (`npm run build`), or something wrote to stdout — stdout is the protocol channel and must carry only MCP messages. |
| `AMBIGUOUS_LIST` | the account has several lists; set `HEB_LIST_ID`. |

Verify the whole path without a client:

```bash
npm run verify:mcp
```
