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

Spark takes an MCP **URL**, not a command, so it needs the HTTP transport that arrives with
W10. It also requires a Google AI Ultra subscription ($99.99/mo), US-only, and setup on the
web app at *Settings → Connected Apps → Custom apps for Spark*. The tools themselves are
unchanged — only the transport differs.

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
| `heb_add_item` | **yes** | takes exactly one of `query` or `productId` |
| `heb_remove_item` | **yes** | takes exactly one of `lineId` or `item` |

A vague `heb_add_item({query})` **writes nothing** — it returns candidate products and asks
you to call again with a `productId`. That is deliberate: an unnecessary question costs two
seconds, whereas silently adding the wrong product costs a wasted trip.

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
