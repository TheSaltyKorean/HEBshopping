variable "region" {
  description = "AWS region. Alexa in North America requires the skill's Lambda in us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
  default     = "heb-shopping"
}

variable "alexa_skill_ids" {
  description = <<-EOT
    The Alexa skill ids (amzn1.ask.skill.…) from the developer console.

    Required, and used twice: they scope the Lambda invoke permission, and the handler
    rejects every other skill. A direct Alexa trigger carries no request signature, so this
    is the only thing preventing another skill that learns the ARN from reading the list.

    A list, because Alexa allows exactly one invocation name per skill. To answer to both
    "grocery list" and "heb list", create two skills with the same interaction model and
    the same endpoint ARN, and put both ids here.
  EOT
  type        = list(string)

  validation {
    # The full shape, not just the prefix. The example file's placeholder carries the
    # prefix too, so a prefix check accepts it — and Terraform then happily deploys an
    # invoke permission and a HEB_SKILL_ID locked to an id no skill will ever present.
    # Everything applies cleanly and the skill is simply dead, with nothing to point at.
    condition = length(var.alexa_skill_ids) > 0 && alltrue([
      for id in var.alexa_skill_ids :
      can(regex("^amzn1\\.ask\\.skill\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))
    ])
    error_message = "alexa_skill_ids must be a non-empty list of real skill ids (amzn1.ask.skill.<uuid>), not the placeholder. Copy each from the Alexa developer console under Build → Endpoint."
  }

  validation {
    # Duplicates would silently collide on the for_each key below, and Terraform's error
    # there names an internal address rather than the real mistake.
    condition     = length(var.alexa_skill_ids) == length(toset(var.alexa_skill_ids))
    error_message = "alexa_skill_ids contains a duplicate skill id."
  }
}

variable "heb_list_id" {
  description = "Pin one H-E-B list. Leave empty unless the account has several."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = <<-EOT
    Where to send the "session expired, please log in" alert. Empty disables it.

    Worth setting: an expired login is a handled error, so the skill keeps answering
    politely and nothing else tells you. The first symptom is otherwise standing in a shop
    with an empty list.
  EOT
  type        = string
  default     = ""
}

variable "enable_mcp_url" {
  description = <<-EOT
    Create the public Function URL for the MCP endpoint.

    Only needed for Gemini Spark, which requires an AI Ultra subscription. Gemini CLI and
    Claude Code use the local stdio server and need nothing deployed, so this defaults off
    — a public URL you are not using is only an attack surface.
  EOT
  type        = bool
  default     = false
}

variable "bundle_path" {
  description = "Zip produced by `npm run bundle`."
  type        = string
  default     = "build/lambda.zip"
}
