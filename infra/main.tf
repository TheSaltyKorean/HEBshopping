/**
 * HEB shopping list — the whole deployment.
 *
 * One Lambda serving two entry points, one small table, and the alarm that tells you when
 * the H-E-B login has expired. Everything here sits inside the AWS always-free tier for a
 * single household's usage: see `docs/deploy.md` for the arithmetic.
 *
 * Deliberately absent: API Gateway (the Function URL is free and one fewer thing to
 * secure), a NAT gateway or VPC (the Lambda only calls the public internet, and a NAT
 * would cost more than everything else combined), and Secrets Manager (SSM Parameter Store
 * is free; Secrets Manager is $0.40/secret/month for the same job).
 */

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "heb-shopping-list"
      ManagedBy = "terraform"
    }
  }
}

locals {
  name = var.name_prefix
}

# ---------------------------------------------------------------------------
# Session store
# ---------------------------------------------------------------------------

/**
 * The cookie jar.
 *
 * Its entire contents are a live credential for an account with a saved payment method, so
 * it is encrypted at rest, point-in-time recoverable, and readable by exactly one role.
 * On-demand billing because the real access pattern is a few reads a day.
 */
resource "aws_dynamodb_table" "session" {
  name         = "${local.name}-session"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    # Losing this table means a human has to log in again at a browser. Cheap to protect.
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# MCP bearer token
# ---------------------------------------------------------------------------

/**
 * The Function URL is open to the internet, so this token is the only thing between a
 * stranger and the household's shopping list.
 *
 * Generated here rather than supplied: a token nobody chose is a token nobody reuses from
 * somewhere else. Deliberately not a Terraform output — read it from SSM when needed; see
 * the Security section of docs/deploy.md.
 */
resource "random_password" "mcp_token" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "mcp_token" {
  name  = "/${local.name}/mcp-token"
  type  = "SecureString"
  value = random_password.mcp_token.result

  lifecycle {
    ignore_changes = [value] # rotate deliberately, not on every apply
  }
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

/** Exactly the four actions the function performs, on exactly its own resources. */
data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.session.arn]
  }

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.mcp_token.arn]
  }

  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }

  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

/**
 * Log retention, set explicitly.
 *
 * The default is "never expire", which slowly turns free-tier logging into a bill. Two
 * weeks is long enough to debug a voice command nobody reported on the day.
 */
resource "aws_cloudwatch_log_group" "alexa" {
  name              = "/aws/lambda/${local.name}-alexa"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/aws/lambda/${local.name}-mcp"
  retention_in_days = 14
}

resource "aws_lambda_function" "alexa" {
  function_name    = "${local.name}-alexa"
  role             = aws_iam_role.lambda.arn
  filename         = var.bundle_path
  source_code_hash = filebase64sha256(var.bundle_path)
  handler          = "alexa.handler"
  runtime          = "nodejs20.x"

  # Alexa allows ~8s end to end; the code enforces a 6.5s budget across its HEB calls.
  # This is the outer backstop, not the real limit.
  timeout     = 10
  memory_size = 512

  environment {
    variables = {
      HEB_SESSION_TABLE = aws_dynamodb_table.session.name
      HEB_SKILL_ID      = var.alexa_skill_id
      HEB_LIST_ID       = var.heb_list_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.alexa]
}

resource "aws_lambda_function" "mcp" {
  function_name    = "${local.name}-mcp"
  role             = aws_iam_role.lambda.arn
  filename         = var.bundle_path
  source_code_hash = filebase64sha256(var.bundle_path)
  handler          = "mcp.handler"
  runtime          = "nodejs20.x"

  timeout     = 15 # no Alexa ceiling here; an agent can wait a little longer
  memory_size = 512

  environment {
    variables = {
      HEB_SESSION_TABLE   = aws_dynamodb_table.session.name
      HEB_MCP_TOKEN_PARAM = aws_ssm_parameter.mcp_token.name
      HEB_LIST_ID         = var.heb_list_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.mcp]
}

/**
 * Alexa invokes the function directly.
 *
 * `event_source_token` pins the permission to one skill, so the ARN alone is not enough to
 * call this function. The code checks the skill id as well — two independent gates,
 * because a direct trigger carries no request signature to verify.
 */
resource "aws_lambda_permission" "alexa" {
  statement_id       = "AllowAlexaSkill"
  action             = "lambda:InvokeFunction"
  function_name      = aws_lambda_function.alexa.function_name
  principal          = "alexa-appkit.amazon.com"
  event_source_token = var.alexa_skill_id
}

/**
 * Public URL for the MCP endpoint.
 *
 * `authorization_type = "NONE"` looks alarming and is correct: Gemini Spark sends a bearer
 * token, not SigV4, so IAM auth would make it unusable. The bearer check in `mcp-http.ts`
 * runs before anything is parsed and compares in constant time.
 */
resource "aws_lambda_function_url" "mcp" {
  count              = var.enable_mcp_url ? 1 : 0
  function_name      = aws_lambda_function.mcp.function_name
  authorization_type = "NONE"
}

/**
 * `authorization_type = "NONE"` is not by itself permission to invoke.
 *
 * Without this statement AWS rejects every request before the function runs, so the
 * bearer check never executes and the endpoint is simply dead. The two are independent
 * layers: AWS decides whether the request reaches the function, and `mcp-http.ts` decides
 * whether the caller is allowed — this grants only the former.
 */
resource "aws_lambda_permission" "mcp_url" {
  count                  = var.enable_mcp_url ? 1 : 0
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.mcp.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# ---------------------------------------------------------------------------
# Alerting
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

/**
 * The alarm that matters: the H-E-B session has expired and a human must log in again.
 *
 * It cannot be built on the Lambda `Errors` metric. `SESSION_EXPIRED` is *handled* — the
 * skill catches it, speaks an apology, and returns normally — so Lambda records a
 * successful invocation and `Errors` stays at zero. An alarm on that metric would look
 * healthy for exactly as long as the skill was broken.
 *
 * So the signal comes from the log line the error handler already writes. It logs the
 * code and nothing else, which is both the privacy rule and, conveniently, a stable
 * string to match.
 */
resource "aws_cloudwatch_log_metric_filter" "session_expired" {
  name           = "${local.name}-session-expired"
  log_group_name = aws_cloudwatch_log_group.alexa.name
  pattern        = "\"HebError SESSION_EXPIRED\""

  metric_transformation {
    name          = "SessionExpired"
    namespace     = "HebShoppingList"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "session_expired" {
  alarm_name          = "${local.name}-session-expired"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.session_expired.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.session_expired.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The H-E-B login has expired. Run `npm run login`, then `npm run push:session`."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

/** Unhandled crashes, which are a different problem with a different remedy. */
resource "aws_cloudwatch_metric_alarm" "alexa_errors" {
  alarm_name          = "${local.name}-alexa-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The Alexa Lambda threw. Check /aws/lambda/${local.name}-alexa."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.alexa.function_name
  }
}
