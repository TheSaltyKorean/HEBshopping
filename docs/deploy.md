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
| The **AWS CLI**, authenticated | `aws sts get-caller-identity` should print your account |
| **Terraform** ≥ 1.5 | `terraform version` |
| An **Amazon developer account** | Free: [developer.amazon.com](https://developer.amazon.com) — use the **same Amazon account your Echo is registered to**, or the skill will not appear on your device |

> **Region is not a free choice.** Alexa in North America requires the skill's Lambda in
> **us-east-1**. That is the default here; changing it will stop the skill working.

---

## Part 1 — Create the Alexa skill

The skill has to exist *before* Terraform runs, because its id is what locks the Lambda to
it. Nothing is published, and nothing is reviewed by Amazon.

### Step 1. Create it

Go to the [Alexa developer console](https://developer.amazon.com/alexa/console/ask) →
**Create Skill**.

- **Name:** anything, e.g. `My Grocery List`
- **Model:** Custom
- **Hosting:** **Provision your own** ← important; do not pick Alexa-hosted
- **Template:** Start from Scratch

### Step 2. Load the interaction model

In the console: **Build → Interaction Model → JSON Editor**. Replace the contents with
this repo's `packages/lambda-api/skill-package/interactionModels/custom/en-US.json`, then
**Save** and **Build Model**.

The invocation name is **"my grocery list"**. Change it in that file if you prefer
something else — it is what you say out loud.

### Step 3. Copy the skill id

**Build → Endpoint**. At the top you will see a skill id like
`amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Copy it.

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

Edit it: paste your skill id into `alexa_skill_id`, and put your address in `alert_email`.
That address is how you find out the H-E-B login has expired — worth setting, because an
expired login is a *handled* error, so the skill keeps answering politely and nothing else
tells you. The first symptom is otherwise standing in a shop with an empty list.

### Step 6. Apply

```bash
terraform -chdir=infra init
terraform -chdir=infra apply
```

Read the plan before confirming. It should create nine resources and destroy none.

If you set `alert_email`, **check your inbox and confirm the SNS subscription** — AWS will
not send alerts until you click that link.

### Step 7. Point the skill at the Lambda

`terraform apply` prints an ARN. Back in the Alexa console: **Build → Endpoint → AWS Lambda
ARN**, paste it into **Default Region**, and **Save Endpoints**.

### Step 8. Upload your H-E-B session

The Lambda cannot read the session file on your laptop.

```bash
npm run push:session -- --table heb-shopping-session --region us-east-1
```

Expect `✅ Session in heb-shopping-session (N cookies)`. It refuses to upload a session
that is already dead, so a failure here means running `npm run login` first.

### Step 9. Talk to it

> *"Alexa, ask my grocery list what is on my list"*

Development-mode skills are enabled automatically on **every Echo registered to the same
Amazon account** — no installation step, and anyone in the house can use it.

---

## Keeping it running

**Roughly monthly**, cookies expire and you get the alert email. Two commands:

```bash
npm run login                 # browser opens; log in
npm run push:session -- --table heb-shopping-session --region us-east-1
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
  permission and in the handler.
- **The MCP Function URL is public when enabled**, protected by a bearer token generated by
  Terraform, stored in SSM, and compared in constant time. Read it with
  `terraform -chdir=infra output -raw mcp_token`. Leave `enable_mcp_url = false` unless you
  actually have Gemini Spark — an unused public URL is only an attack surface.
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
| Skill says "my H-E-B login has expired" but the laptop works | You skipped step 8 after logging in. |
| `There was a problem with the requested skill's response` | Check CloudWatch `/aws/lambda/heb-shopping-alexa`. A cold-start throw is almost always missing configuration. |
| The skill does not respond on your Echo | The Echo is registered to a different Amazon account than the developer account. |
| `BOT_CHALLENGE` from the skill only | See *The one unknown* above. |
| `terraform apply` fails on `prevent_destroy` | Intentional — the session table is protected. Remove that block deliberately if you really mean to delete it. |
