# Setup — step by step

Everything you need to go from a fresh clone to adding groceries by voice or by agent.

Follow **Part 1** and **Part 2** once. Then pick whichever methods in **Part 3** you
actually want — they're independent, and you can enable more later.

---

## Before you start

| You need | Why |
|---|---|
| An **H-E-B account** with at least one shopping list | This drives your real list. Create one at [heb.com](https://www.heb.com) first if you haven't. |
| **Node.js `^20.19` or `>=22.12`** | Check with `node --version`. Earlier 20.x and 22.x releases fail: Vitest pulls in Vite, which requires these minimums, so the version check passes and `npm test` then does not. |
| **git** | To clone. |
| A machine with a **screen** | Logging in opens a real browser window. A headless server won't work for this one step. |

Roughly 10 minutes.

---

## Part 1 — Install

### Step 1. Clone the repo

```bash
git clone https://github.com/TheSaltyKorean/HEBshopping.git
cd HEBshopping
```

### Step 2. Install dependencies

```bash
npm install
```

### Step 3. Install the browser Playwright uses

This is separate from `npm install` and easy to miss. Without it, Step 5 fails.

```bash
npx playwright install chromium
```

### Step 4. Build

```bash
npm run build
```

Confirm it's sound before going further:

```bash
npm test
```

Expected: every file passes and nothing is skipped — the counts grow as the project does,
so match on `passed` rather than a number. These run entirely offline, so if they pass,
your install is good.

---

## Part 2 — Log in

### Step 5. Run the login tool

```bash
npm run login
```

A Chromium window opens on heb.com. **Log in there by hand** — password, emailed OTP, or
passkey all work. The tool watches for your session to become valid; it never types a
credential for you and never sees your password.

When it succeeds you'll see something like:

```
✅ Session written to /path/to/HEBshopping/.session/session.json (mode 0600).

  26 cookies across: .heb.com, accounts.heb.com, www.heb.com
  Usable for about 29 day(s) — soonest required cookie to expire.
    sat      59d
    sst      364d
    reese84  29d

Verifying against the live API …
  ✅ "Shopping" — 1 item(s)
```

That last line is the proof: it made a real authenticated call and saw your real list.

> **`.session/session.json` is a live credential.** Anyone holding that file is logged in
> as you, on an account with a saved payment method. It's written owner-only (mode 0600)
> and gitignored. Don't copy it around, don't paste it anywhere.

> **On Windows, mode 0600 does nothing.** Node maps `chmod` onto the single read-only
> attribute and ignores the rest, so the file gets whatever NTFS ACL it inherits from its
> directory. That matters because of *where you cloned*: a repo under `C:\git\` inherits
> `C:\`'s default ACL, which grants local `Users` read access — so on a machine with more
> than one account, another user can read your session. Under your own profile
> (`C:\Users\<you>\...`) the inherited ACL is already user-only and there is nothing to fix.
>
> If the repo lives outside your profile, restrict the directory once:
>
> ```powershell
> icacls .session /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
> ```
>
> The same applies to `captures/` if you ever run `npm run capture`, which writes raw cookie
> jars and request bodies.

### Step 6. Confirm it works

```bash
npm run verify:session
```

Read-only — it lists, it never changes anything.

```
  session usable: true, expires 2026-08-31T06:09:22.038Z
✅ 685ms — 1 list(s)
   "Shopping" — 1 item(s)
```

**You now have a working setup.** Pick a method below.

---

## Part 3 — Choose how to use it

### Method A — Claude Code

Already wired: `.mcp.json` in the repo root registers the server for this project.

**Step A1.** Start Claude Code from the repo directory:

```bash
cd /path/to/HEBshopping
claude
```

**Step A2.** Approve the `heb-shopping-list` server when prompted.

**Step A3.** Confirm it connected:

```
/mcp
```

You should see `heb-shopping-list` with four tools.

**Step A4.** Just ask:

> add green chili enchilada sauce to the shopping list

If the request is vague, it won't guess — it comes back with candidate products and asks
which you meant. That's deliberate; see *How adding actually behaves* below.

---

### Method B — Gemini CLI

**Step B1.** Find your absolute path:

```bash
pwd
```

**Step B2.** Add this to `~/.gemini/settings.json`, substituting that path in both places:

```jsonc
{
  "mcpServers": {
    "heb-shopping-list": {
      "command": "node",
      "args": ["/absolute/path/to/HEBshopping/packages/mcp-server/dist/stdio.js"],
      "env": {
        "HEB_SESSION_PATH": "/absolute/path/to/HEBshopping/.session/session.json"
      }
    }
  }
}
```

Absolute paths are required — Gemini CLI does not launch the server from this directory,
so relative paths resolve somewhere unexpected.

**Step B3.** Restart Gemini CLI and ask it to add something.

---

### Method C — The command line

No agent involved. Useful for testing, and for checking the plumbing when something else
misbehaves.

```bash
npm run verify:session   # read-only: is my session alive?
npm run verify           # full add → read → remove cycle; cleans up after itself
npm run verify:mcp       # drives the MCP server exactly as a real client would
npm run verify:alexa     # drives the Alexa skill exactly as an Echo would
npm run scan             # secret + PII scan of everything git would commit
```

`npm run verify`, `npm run verify:mcp`, and `npm run verify:alexa` **write to your real
list** and then undo themselves — the Alexa one diffs line ids so it can only remove what it
added. They touch lists only: never the cart, never checkout.

---

### Method D — Alexa

The skill is **built, verified, and deployable** — see [`deploy.md`](deploy.md) for putting
it on your Echo. You can also drive the whole conversation locally, with no AWS at all:

```bash
npm run verify:alexa
```

That builds real Alexa request envelopes, threads session attributes between turns exactly
as Alexa does, and runs them against your real list — everything an Echo does except the
speech recognition. It cleans up after itself by line id, so it only removes what it added.

Expect output like:

```
🗣  add green chili enchilada sauce
🔊 Did you mean Hatch Medium Green Garlic Enchilada Sauce?
🗣  no
🔊 Did you mean Old El Paso Chile Enchilada Sauce?
🗣  yes
🔊 Added Old El Paso Chile Enchilada Sauce. Anything else?
```

**How the conversation works.** Against real H-E-B search results almost every spoken
request is ambiguous — "flour tortillas" matches sixty products — so confirmation is the
normal path, not an error case:

| You say | It does |
|---|---|
| "add oat milk" | offers one candidate: *"Did you mean Oatly The Oat Milk?"* |
| "no" | offers the next one |
| "no" again (3rd refusal) | gives up and puts the options on a card in the Alexa app |
| "yes" | adds exactly the product it just named |
| "what's on my list" | reads up to 7 items; longer lists get a count plus a card |
| "remove tortillas" | same yes/no walk, against your list rather than the catalog |

One candidate is offered at a time on purpose. Three long product names read aloud is
unusable, and there's no screen to fall back on — which is what the app card is for.

The skill package for the ASK CLI lives in `packages/lambda-api/skill-package/`
(`skill.json` plus the en-US interaction model). The invocation name is **"grocery
list"**; change it in `interactionModels/custom/en-US.json` if you'd rather say something
else.

Alexa allows **one invocation name per skill** — there is no alias list. To answer to
several names, create one skill per name, all pointing at the same Lambda, and list every
skill id in `alexa_skill_ids`. [`deploy.md`](deploy.md) has the steps.

### Putting it on your Echo

**[`deploy.md`](deploy.md) is the step-by-step.** In outline: create a development-mode
skill in the Alexa console, `terraform apply` the AWS side, point the skill at the printed
Lambda ARN, and upload your H-E-B session with `npm run push:session`.

A development-mode skill is enabled on **every Echo registered to your Amazon account**,
with no installation step and no certification, so anyone in the house can use it. It will
never be on the Alexa Skill Store; see the README for why that is structurally impossible.

---

## How adding actually behaves

Worth knowing before you're surprised by it.

| Situation | What happens |
|---|---|
| Clear match | Added, and confirmed back using the **resolved product name** — not what you said. |
| Vague request | **Nothing is written.** You get candidate products and a question. |
| Already on the list | Quantity increases; it doesn't duplicate the line. |
| No match at all | Falls back to a **plain written line** — the same thing H-E-B's own `Add "<what you typed>" to list` button creates. You get a line saying what you asked for, with no product attached. |
| Asked for by weight | "Two pounds of sliced turkey" orders **two pounds**, not two turkeys. See below. |

The bias is deliberate: an unnecessary "did you mean?" costs two seconds, while silently
adding the wrong product costs a wasted trip to the store.

### Buying by the pound

Deli meat and cheese sliced to order, and seafood, are priced per pound, so you can ask for
an amount:

> "Alexa, ask grocery list to add two pounds of honey smoked turkey breast"
> "…add half a pound of sliced cheddar"
> "…add a pound and a half of jumbo shrimp"

H-E-B accepts weights on a fixed ladder — quarter-pound steps — so your amount is rounded to
the nearest rung, ties rounding **up**. The confirmation says what actually landed, and the
list reads back in pounds: *"2 pounds of H-E-B Deli Honey-Smoked Turkey Breast."*

Two things this deliberately does **not** do:

- **Packaged goods ignore the weight.** "Two pounds of chicken breasts" gets you one package
  of chicken breasts, because that is how they are sold — you cannot buy 2 lb of a 2.85 lb
  package. The spoken confirmation names the package, so you always hear which happened.
- **Ounces and grams are converted, then rounded.** "Six ounces of turkey" is converted to
  pounds (0.375 lb) and snapped to the same quarter-pound ladder as a pound request — here,
  0.5 lb. The confirmation always says what actually landed, so you hear the rounding.

A phrase only counts as an amount when it reads like one — "two pounds **of** turkey". The
word *of* is the whole test, fractions included: "1.5 lb ground beef", "half pound ground
beef patties" and "pound cake" are all product names, and are searched as written.

### It learns your habits

Ranking uses two personal signals, both **tiebreakers only** — they reorder products the
words cannot separate, and never override a better match:

1. **Bought before** — from H-E-B's own "Buy it again" data for your account.
2. **House brands** — H-E-B, then Mi Tienda, then Hill Country Fare.

In practice that turns "tortilla chips" into the H-E-B Bakery *Unsalted* ones you actually
buy rather than the Sea Salt ones, and "russet potatoes" into the 5 lb bag rather than the
4 ct. Neither signal touches confidence, so "oat milk" can never resolve to H-E-B *dairy*
milk just because the brand is preferred.

---

## Keeping it working

### Re-logging in

Sessions last about a month — `reese84` is the limiter at ~30 days, even though other
cookies run to a year. When it expires you'll get `SESSION_EXPIRED`.

```bash
npm run login
```

Same as Step 5. No restart needed for **local** clients — the session is read from disk on
every request, so a running MCP server picks up the new one on its next call.

> **If you have deployed to AWS, there is a second step.** The Lambda reads DynamoDB, not
> your laptop, so a fresh login is invisible to it until you upload it:
>
> ```bash
> npm run push:session -- --table "$(terraform -chdir=infra output -raw session_table)" --region us-east-1
> ```
>
> Forgetting this is the most common deployment failure: local commands work while the
> skill insists the login has expired. See [`deploy.md`](deploy.md).

There is no way to automate this away: HEB's OTP and passkey options can't be replayed
without a human. Roughly a two-minute chore, once a month.

### Switching to a different H-E-B account

The browser profile stays logged in, so a plain `npm run login` will keep using the old
account. To forget it first:

```bash
npm run login -- --switch
```

That deletes the saved browser profile and starts a clean login.

### Using a session file somewhere else

```bash
npm run login -- --session /custom/path/session.json
```

Point `HEB_SESSION_PATH` at the same path in your MCP client config.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `SESSION_EXPIRED` | Cookies expired. `npm run login` — and if you have deployed, `npm run push:session` afterwards, or the Lambda keeps using the old jar. |
| `npm run login` hangs at "Waiting for a usable session" | You aren't logged in yet in the browser window, or the login didn't finish. It waits 10 minutes, then gives up without writing anything. |
| `browserType.launch: Executable doesn't exist` | You skipped Step 3. Run `npx playwright install chromium`. |
| MCP client disconnects immediately | Either you skipped `npm run build`, or something wrote to stdout. Stdout is the protocol channel and must carry MCP messages only. |
| `AMBIGUOUS_LIST` | Your account has several lists and none is obviously default. Set `HEB_LIST_ID` in the client config. |
| `PRODUCT_NOT_FOUND` | H-E-B's search didn't surface it. Try a brand name — the catalog also has many Spanish product names (*Salsa Verde Para Enchiladas* rather than *green enchilada sauce*), so the English words don't always hit. |
| `BOT_CHALLENGE` | Imperva served an interstitial. Wait a minute and retry; if it persists, `npm run login`. |
| Item added but not visible in the H-E-B app | The app caches aggressively. Pull to refresh, or force-close and reopen. Confirm what the server actually has with `npm run verify:session`. |

---

## What's stored where

| Path | Contents | In git? |
|---|---|---|
| `.session/session.json` | your live session cookies | **never** — gitignored, mode 0600 |
| `.playwright-profile/` | the logged-in browser profile | **never** — gitignored |
| `captures/` | raw discovery output; only created by `npm run capture` | **never** — gitignored |

Run `npm run scan` any time to check nothing sensitive has crept into a committable file.
