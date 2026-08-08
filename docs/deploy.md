# Deploying — step by step

This puts the Alexa skill on your own Echo devices. It is **not** required for the MCP
side: Gemini CLI and Claude Code run the local stdio server and need nothing deployed.

Budget about 45 minutes, most of it waiting on Amazon's consoles.

---

## Before you start

| You need | Notes |
|---|---|
| A working local setup | Finish [`setup.md`](setup.md) first — `npm run login` must succeed |
| An **AWS account** | Free tier covers all of this; see *What this costs* below |
| The **AWS CLI**, authenticated | `aws sts get-caller-identity` should print your account. If it doesn't, see *Getting AWS credentials* below |
| **Terraform** ≥ 1.5 | `terraform version` |
| An **Amazon developer account** | Free: [developer.amazon.com](https://developer.amazon.com) — use the **same Amazon account your Echo is registered to**, or the skill will not appear on your device |

### Getting AWS credentials

Skip this if `aws sts get-caller-identity` already prints your account.

An *access key ID* (`AKIA…`) and *secret access key* are a username/password pair for
programs rather than people. AWS generates them; the secret is shown exactly once.

In the [AWS console](https://console.aws.amazon.com) → **IAM** → **Users** → **Create user**:

1. Name it something like `heb-deploy`. Leave console access **unchecked** — this identity
   is only for the CLI.
2. **Attach policies directly** → **`AdministratorAccess`**.
3. Create the user, open it, → **Security credentials** → **Create access key** → use case
   **Command Line Interface (CLI)**.
4. Copy the secret before leaving the page.

Then `aws configure`, answering `us-east-1` for the region and `json` for the output format.

Two notes. **`AdministratorAccess` is broad**, and it is suggested only because Terraform
here creates a wide spread of resource types — DynamoDB, Lambda, IAM, CloudWatch, SNS, SSM
— and hand-scoping a policy to exactly that set is a fiddly job that tends to end in a
series of `AccessDenied` round trips. For a personal account it is the usual trade; scope it
down afterwards if you like, since `terraform state list` then tells you the exact set.
**Do not create root access keys** — the root user's permissions can't be scoped down with an
IAM policy, so a leaked root key hands over the whole account instead of the limited set an
IAM user's key would.

`aws configure` is interactive, so it needs a real terminal. Running it somewhere without an
attached stdin fails immediately with `EOF when reading a line` and writes nothing.

> **Region is not a free choice.** Alexa in North America requires the skill's Lambda in
> **us-east-1**. That is the default here; changing it will stop the skill working.

---

## Part 1 — Create the Alexa skill

The skill has to exist *before* Terraform runs, because its id is what locks the Lambda to
it. Nothing is published, and nothing is reviewed by Amazon.

> **The Alexa console is redesigned periodically and these labels drift.** Where the wording
> below doesn't match what you see, the shape of the flow is still right: create a custom,
> self-hosted skill, paste the interaction model, build it, take the id.

### Step 1. Create it

Go to the [Alexa developer console](https://developer.amazon.com/alexa/console/ask) →
**Create Skill**.

- **Skill name:** anything, e.g. `My Grocery List` — the display name, not what you say
- **Primary locale:** English (US)
- **Experience type:** Other
- **Model:** Custom
- **Hosting:** **Provision your own** ← important; do not pick Alexa-hosted
- **Template:** Start from Scratch

"Provision your own" is the one that matters: the default is Alexa-hosted, which gives you a
Lambda inside Amazon's account that cannot reach your DynamoDB table. Picking it means
deleting the skill and starting again.

**No Create Skill button?** You are probably not on the console itself — check the address
bar reads `developer.amazon.com/alexa/console/ask` and not a `/dashboard` or Alexa Skills
Kit marketing page. If you have never used the console before, it also gates skill creation
behind a one-time developer profile (name, country, an agreement checkbox — free, no payment
details).

### Step 2. Load the interaction model

In the console: **Build → Interaction Model → JSON Editor**. Replace the contents with
this repo's `packages/lambda-api/skill-package/interactionModels/custom/en-US.json`, then
**Save**, and then build it — the build control is labelled **Build Model** in older
consoles and **Build Skill** in newer ones; there is only one build action either way. It
takes a minute or two.

It worked if the invocation name reads **heb shopper** and the intent list shows
`AddItemIntent`, `ReadListIntent` and `RemoveItemIntent` beside the standard `AMAZON.*` ones.

The invocation name is **"heb shopper"** — what you say out loud. You can change it in that
file, but read the next paragraph first, because most of the obvious names do not work.

#### The name must not contain a word Alexa already owns

Alexa's built-in features claim large parts of the vocabulary, and they win. An invocation
name containing **list**, **cart**, or **shopping** loses to the built-in feature at
runtime: the console accepts the name, the model builds successfully, and then the Echo
answers from Alexa's own shopping list or cart, confidently, with nothing in the reply
suggesting your skill was never reached. Your Lambda records no invocation at all, because
none was made.

Measured on a real account, in this order:

| Invocation name | What answered |
|---|---|
| `grocery list` | Alexa's built-in shopping list |
| `heb list` | built-in Lists — "No list called heb." |
| `heb cart` | Amazon's shopping cart — "Your cart is empty." |
| `heb shopper` | **the skill** |

"list" is the worst of them, because `ask ⟨name⟩ list …` is exactly how you address a
built-in list, so the name is parsed as a list *name*. Pick something with no retail noun
in it at all.

#### Answering to more than one name

**Alexa allows exactly one invocation name per skill.** There is no list of aliases, so the
name is a choice, not a setting.

You can still have both, by creating a second skill that points at the same Lambda:

1. Create another development-mode skill in the console, with a different invocation name.
2. Paste the **same** interaction model, changing only `invocationName`.
3. Under **Build → Endpoint**, paste the **same** Lambda ARN.
4. Copy its skill id and add it to `alexa_skill_ids` in `terraform.tfvars`:

   ```hcl
   alexa_skill_ids = [
     "amzn1.ask.skill.<first>",
     "amzn1.ask.skill.<second>",
   ]
   ```

5. `terraform apply` again. Both skills now reach the same list, and no code changes.

Extra skills cost nothing — Lambda's free tier is per account, not per skill.

Two rules the console enforces when you pick a name:

- **Two or more words**, unless the name is a distinctive brand you own. Single common
  words like "groceries" are rejected at model-build time. "heb shopper" is fine; plain
  "heb" most likely is not.
- Names are checked when the model builds, so you find out immediately, not at deploy.

### Step 3. Copy the skill id

**Build → Endpoint**. At the top you will see a skill id like
`amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Copy it.

**Can't find Endpoint in the sidebar?** Newer consoles bury or rename it. You do not need
the page yet — the id is in the address bar of any skill-editing screen:

```
developer.amazon.com/alexa/console/ask/build/custom/amzn1.ask.skill.<uuid>/development/…
```

The skill list also offers a **Copy Skill ID** control per skill. You will have to find the
Endpoint page eventually, for Step 7, but by then you will have an ARN to paste and a reason
to hunt.

Leave the endpoint fields empty for now: the Lambda does not exist yet, and it cannot be
created until Terraform has this id. That circularity is deliberate — the id is what locks
the Lambda to your skill.

---

## Part 2 — Deploy the AWS side

### Step 4. Build the bundle

```bash
npm run build
npm run bundle
```

Expect `infra/build/lambda.zip`, around 0.5 MB.

### Step 5. Configure

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Edit it: paste your skill id into `alexa_skill_ids` (a list — add more if you create extra
invocation names, see below), and put your address in `alert_email`.

> **On a new AWS account, also uncomment `alexa_reserved_concurrency = -1`.**
>
> A fresh AWS account's Lambda **Concurrent executions** quota is 10, not the 1000 a mature
> account has. AWS rejects any reservation that would leave unreserved concurrency below 10
> — so on a new account *no reservation of any size is possible*, and Step 6 fails partway
> through with:
>
> ```
> InvalidParameterValueException: Specified ReservedConcurrentExecutions for function
> decreases account's UnreservedConcurrentExecution below its minimum value of [10].
> ```
>
> Check yours with `aws lambda get-account-settings --query
> 'AccountLimit.ConcurrentExecutions'`. If it prints `10`, uncomment the line.
>
> The 10-execution floor is account-wide, not per-function: if you also set `enable_mcp_url
> = true`, uncommenting this line disables *that* function's reservation too, not just
> Alexa's — otherwise Step 6 fails the same way on the MCP function instead.
>
> The reservation exists to bound how many invocations call H-E-B in parallel (see the
> comment on `aws_lambda_function.alexa`), so losing it is a real if small cost — though on
> such an account the limit of 10 is itself the ceiling. The permanent fix is to raise the
> quota in **Service Quotas → Lambda → Concurrent executions**, which is free and
> adjustable; then delete the line and re-apply to get the intended reservation of 2 back.

That address is how you find out the H-E-B login has expired — worth setting, because an
expired login is a *handled* error, so the skill keeps answering politely and nothing else
tells you. The first symptom is otherwise standing in a shop with an empty list.

### Step 6. Apply

```bash
terraform -chdir=infra init
terraform -chdir=infra apply
```

Read the plan before confirming. **The number that matters is `0 to destroy`** — with the
documented defaults it creates around fourteen resources, and enabling `alert_email` or
`enable_mcp_url` adds a few more, so an exact count is not a useful check. What you should
see: a DynamoDB table, two Lambda functions, an IAM role and policy, two log groups, an SSM
parameter, an SNS topic, and a metric filter with two alarms.

If you set `alert_email`, **check your inbox and confirm the SNS subscription** — AWS will
not send alerts until you click that link. It arrives from Amazon SNS's no-reply address at
`sns.amazonaws.com`, subject "AWS Notification - Subscription Confirmation", and **routinely
lands in junk**; the link expires after three days. Check the status with:

```bash
aws sns list-subscriptions-by-topic --output text \
  --topic-arn "$(terraform -chdir=infra output -raw alerts_topic)" \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]'
```

`PendingConfirmation` in place of an ARN means it has not been clicked. AWS cannot resend,
so if the mail never arrives, recreate the subscription:
`terraform -chdir=infra apply -replace='aws_sns_topic_subscription.email[0]'`.

This does not gate the skill — an unconfirmed subscription costs you only the warning when
the H-E-B cookies expire, which is the one failure nothing else announces.

### Step 7. Point the skill at the Lambda

`terraform apply` prints an ARN. Back in the Alexa console: **Build → Endpoint → AWS Lambda
ARN**, paste it into **Default Region**, and **Save Endpoints**.

### Step 8. Upload your H-E-B session

The Lambda cannot read the session file on your laptop.

```bash
npm run push:session -- \
  --table "$(terraform -chdir=infra output -raw session_table)" \
  --region us-east-1
```

Taking the name from Terraform rather than hard-coding it, because it follows
`name_prefix` — hard-coding works only until someone changes that variable, and then it
silently writes to a table nothing reads.

Expect `✅ Session in … (N cookies)`. It checks the session against H-E-B before
uploading, so a failure here means running `npm run login` first.

### Step 9. Talk to it

> *"Alexa, ask heb shopper **skill** what is on my list"*

On Alexa+ that trailing "skill" is required — see below. It is harmless on classic Alexa,
so it is the phrasing to learn.

Development-mode skills are enabled automatically on **every Echo registered to the same
Amazon account** — no installation step, and anyone in the house can use it.

#### On Alexa+, say the word "skill"

**This is the single most important sentence in this document if your account is on
Alexa+.** The invocation name alone is not enough:

| Said | Reached |
|---|---|
| "ask heb shopper what is on my list" | Alexa's built-in Lists |
| **"ask heb shopper skill what is on my list"** | **this skill** |
| "ask the heb shopper skill what is on my list" | this skill |
| "open heb shopper" | built-in Lists — offers to *create* a list called "heb shopper" |
| "open heb shopper skill" | this skill |

Without the trailing word "skill", Alexa+ reads the invocation name as the name of one of
*its* lists, and answers about that instead — cheerfully, and with no indication your skill
was skipped. It will even offer to create a list by that name, which is how you end up with
a stray "heb shopper" list in the Alexa app.

A successful reply opens with *"Here's ⟨skill name⟩. Say 'Alexa exit' to get back to Alexa
plus."* That sentence is the proof the request reached your skill.

This applies to Alexa+ specifically. On classic Alexa the bare invocation name works as
Amazon's own documentation describes, and the extra word is harmless there — so say it
either way. Amazon has acknowledged that custom skills have "functionality issues" on
devices running Alexa+ while it is in active development, so expect this to shift.

#### The invocation name has to be in the sentence, exactly

A custom skill is only reached by naming it, and the name has to match. Without that, Alexa
answers from its own built-in shopping list, which does not look like a failure at all — it
replies, cheerfully, about a completely different list:

| Reaches this skill | Reaches Alexa's own list |
|---|---|
| "Alexa, ask heb shopper skill what is on my list" | "Alexa, what's on my shopping list" |
| "Alexa, ask heb shopper skill to add milk" | "Alexa, add milk to my shopping list" |
| "Alexa, ask heb shopper skill to remove eggs" | "Alexa, ask **my** heb shopper skill what is on my list" |

That last one is the trap: an extra word *inside* the name breaks the match as completely as
omitting the name would, and the reply sounds fine.

If you renamed the skill to something overlapping a built-in Alexa feature, this is also
where that shows up — see *The name must not contain a word Alexa already owns* under Step
2. Changing it back means editing `invocationName` in
`packages/lambda-api/skill-package/interactionModels/custom/en-US.json`, pasting the model
again, and rebuilding. Nothing on the AWS side changes: same skill id, same Lambda, same ARN.

#### Diagnosing "it just doesn't answer"

Alexa reports almost every failure as the same vague apology, so work from evidence instead
of the spoken message. In order:

1. **Did the Lambda run at all?** This is the ground truth, and it splits the problem in
   half — no invocation means the request never left Amazon, so nothing on the AWS side can
   be at fault.

   ```bash
   aws logs filter-log-events --log-group-name /aws/lambda/heb-shopping-alexa \
     --start-time $(( ($(date -u +%s) - 900) * 1000 )) \
     --query 'events[].[message]' --output text | grep -c "START RequestId"
   ```

2. **Is the endpoint reachable, ignoring speech?** Developer console → **Test** → **Manual
   JSON**, and post a `LaunchRequest` envelope. That skips NLU entirely and calls your
   endpoint directly. Success here plus no voice response means the endpoint is fine and the
   problem is routing.

3. **What does the real NLU do?** The [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
   runs the same path a device uses, and prints the actual outcome rather than a spoken
   apology:

   ```bash
   npm install -g --prefix ~/.local ask-cli     # no sudo; ~/.local/bin is usually on PATH
   ask configure --no-browser                   # --no-browser if port 9090 is taken (Cockpit uses it)

   ask smapi get-skill-enablement-status --skill-id <id> --stage development
   ask smapi get-interaction-model --skill-id <id> --stage development --locale en-US
   ask smapi simulate-skill --skill-id <id> --stage development \
     --device-locale en-US --input-content "ask heb shopper skill what is on my list"
   ```

   `get-skill-enablement-status` returns success (204) when enabled and 404 when not.
   `get-interaction-model` returns what Alexa actually holds live, which settles any doubt
   about whether a rebuild took effect — far quicker than reading it off a console screen.

---

## Keeping it running

**Roughly monthly**, cookies expire and you get the alert email. Two commands:

```bash
npm run login                 # browser opens; log in
npm run push:session -- \
  --table "$(terraform -chdir=infra output -raw session_table)" \
  --region us-east-1
```

**Forgetting the second one is the most common failure.** The laptop works, the skill says
the login expired, and nothing looks wrong. If in doubt, run it.

---

## What this costs

$0.00/month for one household, inside the AWS always-free tier:

| Resource | Free allowance | Realistic usage |
|---|---|---|
| Lambda | 1M requests, 400k GB-s per month | a few hundred invocations |
| DynamoDB on-demand | 25 GB storage | one row, a few KB |
| Lambda Function URL | free (no API Gateway) | off by default |
| SSM Parameter Store | free (standard tier) | one parameter |
| SNS | 1,000 email notifications | a handful a year |
| CloudWatch Logs | 5 GB ingest | 14-day retention, set explicitly |

The always-free tiers do not expire after 12 months. The one thing that could cost money is
CloudWatch log retention, which is why it is capped rather than left at "never expire".

---

## Security notes

- **The DynamoDB table holds a live credential.** Encrypted at rest, point-in-time
  recoverable, readable only by the Lambda role, and `prevent_destroy` is set — losing it
  costs a human login.
- **`HEB_SKILL_ID` is mandatory** and the Lambda refuses to start without it. A direct
  Alexa trigger carries no request signature to verify, so the skill id is the only thing
  stopping another skill that learns your ARN. It is enforced twice: in the invoke
  permission and in the handler. With several invocation names it holds a comma-separated
  list, and each id gets its own invoke permission — a wider grant is never issued.
- **The MCP Function URL is public when enabled**, protected by a bearer token generated by
  Terraform, stored in SSM, and compared in constant time. Terraform deliberately does not
  output the value — a Terraform output would sit in plain text in state *and* in anyone's
  scrollback. Read it from SSM when you need it:

  ```bash
  aws ssm get-parameter --with-decryption \
    --name "$(terraform -chdir=infra output -raw mcp_token_parameter)" \
    --query Parameter.Value --output text
  ```

  Leave `enable_mcp_url = false` unless you actually have Gemini Spark — an unused public
  URL is only an attack surface.
- **`infra/terraform.tfvars` and `infra/*.tfstate` are gitignored.** State contains ARNs
  and the generated token; treat the directory as sensitive.

---

## The one unknown

Nobody has measured whether Imperva treats **AWS IP ranges** more harshly than a home
connection. Everything works from a laptop; the deployed Lambda is the first time this runs
from a datacentre.

If it bites, you will see `BOT_CHALLENGE` from the skill while local commands keep working.
The fallback is to run the session refresh from a residential machine behind a Cloudflare
Tunnel — the `Store` seam means that is a swap, not a rewrite. It is the last unmeasured
assumption in the project, and deploying is the only way to answer it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Alexa answers about a *different* list, cheerfully | The invocation name was missing, inexact ("ask **my** heb shopper"), or contains a word Alexa owns — *list*, *cart*, *shopping*. Alexa fell through to its own built-in. See Step 2 and Step 9. |
| Alexa offers to *create* a list named after your skill | Alexa+ read the invocation name as one of its own list names. Add the word "skill": `ask ⟨name⟩ skill ⟨request⟩`. See Step 9. |
| "An unexpected error occurred" on `open ⟨name⟩` | Same cause — say `open ⟨name⟩ skill`, or use the `ask` form. See Step 9. |
| Skill never answers, and the Lambda shows zero invocations | The request never left Amazon — routing or naming, not AWS. Work through *Diagnosing "it just doesn't answer"* in Step 9. |
| `terraform apply` fails with `InvalidParameterValueException … below its minimum value of [10]` | New AWS account, Lambda concurrency quota of 10. Set `alexa_reserved_concurrency = -1`, or raise the quota. See Step 5. |
| `aws configure` exits with `EOF when reading a line` | It is interactive and had no terminal attached. Run it in a real shell. |
| No "Create Skill" button in the Alexa console | Wrong page, or the one-time developer profile is not finished. See Step 1. |
| No "Endpoint" entry in the console sidebar | Newer console layout. The skill id is in the page URL — see Step 3. |
| The SNS confirmation email never arrived | Check junk. AWS cannot resend; recreate the subscription — see Step 6. |
| Skill says "my H-E-B login has expired" but the laptop works | You skipped step 8 after logging in. |
| `There was a problem with the requested skill's response` | Check CloudWatch `/aws/lambda/heb-shopping-alexa`. A cold-start throw is almost always missing configuration. |
| The skill does not respond on your Echo | The Echo is registered to a different Amazon account than the developer account. |
| `BOT_CHALLENGE` from the skill only | See *The one unknown* above. |
| `terraform apply` fails on `prevent_destroy` | Intentional — the session table is protected. Remove that block deliberately if you really mean to delete it. |
