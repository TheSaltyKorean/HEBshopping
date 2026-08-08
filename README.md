# HEB Shopping List — Voice + MCP

Add, read, and remove items on a real H-E-B shopping list by voice (Alexa) and by agent
(Gemini / MCP), for $0/month on the AWS free tier.

> **Not affiliated with, endorsed by, or supported by H-E-B.** This uses the same private
> GraphQL endpoint heb.com's own front end uses. It can break without warning, and using it
> is your call and your risk.

## Read this first

**This is not a product. It is one household's setup, published so you can copy it.**
There is nothing to install and no service to sign up for. If you want it, you fork it and
run your own copy.

| | |
|---|---|
| **One H-E-B account, one household** | The whole design assumes a single account and a single shared list. There is no multi-tenancy and no per-user auth. |
| **You deploy your own** | Your AWS account, your Alexa developer account, your HEB login. Nothing is hosted for you. |
| **Not on the Alexa Skill Store** | And it can't be — see below. You install it as a development-mode skill on your own Amazon account. |
| **You log in yourself, in a browser** | This software never sees a password. See *Why there's no password field*. |
| **H-E-B only** | Texas and northern Mexico. Useless without an H-E-B account. |

### What "development mode" actually gets you

A development-mode Alexa skill is enabled on **every Echo registered to your Amazon
account**, indefinitely, with no certification and no renewal. Anyone in the house can talk
to it — there's no account linking, so Alexa never asks who's speaking. For a shared
grocery list that's the correct behaviour: everyone's items land on the one list.

What it does *not* do is reach anyone else's Echo. Another household needs its own Amazon
account, its own AWS deploy, and its own HEB login — i.e. their own fork of this repo.

### Why this can't be a public Alexa skill

Not a limitation of the code, and not something a pull request can fix:

- **Alexa account linking requires an OAuth2 provider.** H-E-B doesn't offer one publicly,
  so there is nothing for other users' accounts to link against.
- **Amazon certification would reject it** — it's built on an undocumented, unauthorized
  API.

### Why there's no password field

The obvious design — "let each user type their H-E-B username and password" — does not
work here, and that's a finding from discovery, not a shortcut:

- H-E-B's login is **OIDC behind Imperva bot protection**, offering password, emailed OTP,
  **and passkey**. OTP and passkey cannot be replayed headlessly, so a server-side login
  form can't complete them.
- Storing other people's H-E-B credentials — for accounts with saved payment methods —
  is a liability this project declines to take on.

Instead, a human logs in once in a real browser and the resulting **cookies** are what get
stored. They last 30–365 days (see *What discovery changed*), so it's a rare chore.

## Status

| Unit | State |
|---|---|
| W0 discovery | ✅ full CRUD found — see `docs/heb-api.md` |
| W1 scaffold | ✅ monorepo, TypeScript, contracts, error taxonomy |
| W2 `Store` port | ✅ `FileStore` locally, `DynamoDbStore` in production |
| W4 GraphQL client | ✅ hand-written queries, no persisted-hash dependency |
| W5 matching | ✅ hybrid ranking + calibrated confidence |
| W6 `ListOps` | ✅ add/read/remove verified against the real list |
| W7 MCP server | ✅ stdio, four tools — see `docs/mcp-setup.md` |
| W3 login tool | ✅ `npm run login` — headed login straight into the `Store` |
| W5.1 search recovery | ✅ bilingual matching + broadened re-search |
| W8 Alexa skill | ✅ handler, interaction model, verified against the real list |
| W8.1 screen support | ✅ Echo Show renders the list on launch, on read, and after every write |
| W10 deploy | ✅ Terraform, DynamoDB store, MCP HTTP endpoint — see `docs/deploy.md`; **applied and running**, verified end to end from a real Echo |
| W12 free-text lines | ✅ read and write — the same `Add "…" to list` line H-E-B's own UI creates |
| W13 weight-based items | ✅ "two pounds of sliced turkey", snapped to H-E-B's quarter-pound ladder |
| W11 harden | not started — needs sustained runtime on the now-live deployment: soak, latency, cost |

The full plan lives at `~/.claude/plans/frolicking-strolling-crab.md`.

## What discovery changed

The design originally assumed HEB's anti-bot token died every ~11 minutes and that requests
needed a live browser. Both turned out to be wrong:

- **A plain HTTP client with captured cookies works.** The browser is only needed to
  *obtain* a session, never to use one.
- **Sessions last 30–365 days.** A soak test ran 52/52 clean probes over 102 minutes.
- **Persisted-query hashes are a trap.** HEB's APQ store is a *cache, not a safelist* —
  delete failed with a byte-correct hash after being evicted. We send our own query text.

Net effect: no scheduled refresher, no container image, no hash-tracking subsystem. One
plain Lambda, one small table, and a human login every month or two.

## Layout

```
packages/heb-core/        session, GraphQL client, matching, list ops   (pure lib, no deps)
packages/mcp-server/      MCP tools over stdio (HTTP endpoint lives in lambda-api)
packages/lambda-api/      Alexa handler, MCP HTTP endpoint, DynamoDbStore
infra/                    Terraform: DynamoDB, Lambda, SSM, SNS, alarms
tools/                    capture, drive, verify, soak, scan CLIs
docs/                     heb-api.md — output of W0
fixtures/                 scrubbed request/response pairs for offline tests
```

`packages/heb-core/src/types.ts` holds the binding contracts. Code against them; don't
reshape them casually. `Store` is the seam that keeps AWS out of the business logic — if you
need AWS to test logic, that seam has been violated.

## Commands

```bash
npm run build           # packages AND tools/ — see the note below
npm test                # vitest; must pass with NO network access
npm run typecheck       # alias for `npm run build`
npm run login           # headed browser login → writes the session to the Store
npm run login -- --switch   # forget the current account first (switch HEB accounts)
npm run verify:session  # read-only: is the stored session alive?
npm run verify          # add → read → remove against the real list
npm run verify:mcp      # drive the MCP server as a real client would
npm run verify:alexa    # drive the Alexa skill as an Echo would
npm run mcp             # run the MCP server over stdio
npm run bundle          # esbuild → infra/build/lambda.zip
npm run push:session    # upload the local session to DynamoDB (after every login)
npm run scan            # secret + PII scan of committable files
npm run capture         # W0 discovery: watch HEB's own GraphQL traffic (advanced)
```

**`build` compiles `tools/` too, and that is deliberate.** `tools/` is a separate,
non-composite project that `tsc --build` does not reach, so for a while `npm run build`
reported success on a `tools/drive.ts` that could not compile at all — the scripts that
mutate a real shopping list were the only code the gate did not check. `build` now runs
both, which costs a second and makes that class of miss impossible.

Before committing: `npm run build && npm test && npm run scan`.

## Quick start

**Full step-by-step instructions are in [`docs/setup.md`](docs/setup.md)** — install, login,
and each way of using it, with expected output and a troubleshooting table. The short
version:

```bash
npm install
npx playwright install chromium   # separate from npm install; easy to miss
npm run build
npm run login                     # a browser opens — log in by hand, once
npm run verify:session            # read-only proof that it works
```

Then pick a method:

| Method | How | Guide |
|---|---|---|
| **Claude Code** | already wired via `.mcp.json`; start Claude Code here, run `/mcp` | [setup.md § Method A](docs/setup.md) |
| **Gemini CLI** | add the server to `~/.gemini/settings.json` | [setup.md § Method B](docs/setup.md) |
| **Command line** | `npm run verify`, `npm run verify:mcp` | [setup.md § Method C](docs/setup.md) |
| **Alexa** | deploy to your own AWS + Amazon accounts | [deploy.md](docs/deploy.md) |

Logging in is the one genuinely manual step, and no amount of engineering removes it: HEB
offers password, emailed OTP, and passkey, and the latter two cannot be replayed headlessly.
Sessions last about a month, so it's a roughly monthly two-minute chore.

## Known limitations

**One account, one household.** There are no named login profiles: the deployment is bound
to whichever H-E-B account ran `npm run login`, and switching accounts means re-running it
with `--switch`. Multi-profile support is a possible future update, not a current feature —
see "Why there's no password field" above for why it is not simply a login form.

**Ounces and grams are converted, then rounded to the nearest quarter pound.** H-E-B's
counter ladder is in quarter-pound steps, so "six ounces of ham" (0.375 lb) is snapped to
0.5 lb and ordered at that weight rather than refused. Ask in pounds — "half a pound", "a
pound and a half" — if you want to be sure of the exact amount written.


**Adding more than one unit at a time is safe against a concurrent change.** Asking for
*one* of something is safe: `addShoppingListItemsV2` merges into an existing line and
increments it server-side, so two people saying "add milk" at the same moment reliably end
at three. Asking for several is handled the same way — one additive `addShoppingListItemsV2`
call per remaining unit, not a single absolute write of the total — so N adds always land N
units on whatever the line currently holds, whoever else is touching it in between.

**Weight is absolute, so counter lines have the same gap.** There is no additive form for
`quantityOrWeight: { weight }`. The line is re-read immediately before the write to keep the
window to a single round trip, and the write never lowers what it just read, but a household
member changing a deli order in that instant can still be overwritten.

## Security

**This handles live session cookies for an account with a saved payment method.** Anyone
holding your `.session/session.json` is logged in as you. Treat it like a password.

If you fork this, these rules are yours to keep:

- `captures/`, `*.har`, storage state, `.session/`, `.env`, and `.playwright-profile/` are
  **gitignored** and contain real credentials. Scrub before anything derived from them
  reaches `fixtures/`.
- **No account identifiers in committed files.** List and item UUIDs identify the account;
  store numbers identify roughly where you live. Use `<listId>`, `<lineId>`, `<storeId>`.
- Secrets live in SSM Parameter Store; the repo holds parameter *names*, never values.
- Never log cookie values, tokens, or full request bodies.

`npm run scan` enforces all of the above against every file git would actually commit —
emails, session cookies, bearer tokens, AWS keys, private keys, account UUIDs, and absolute
home paths. It exits non-zero, so wire it into a pre-commit hook or CI. **Run it before
your first push**, because scrubbing a secret out of git history is far worse than never
committing it.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, sell it; keep the copyright notice, expect
no warranty.

"H-E-B" is a trademark of H-E-B, LP. This project is not affiliated with or endorsed by
them, and the MIT grant covers this code only — not any right to use H-E-B's services.
