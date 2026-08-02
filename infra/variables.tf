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

variable "alexa_skill_id" {
  description = <<-EOT
    The Alexa skill id (amzn1.ask.skill.…) from the developer console.

    Required, and used twice: it scopes the Lambda invoke permission to one skill, and the
    handler rejects any other. A direct Alexa trigger carries no request signature, so this
    is the only thing preventing another skill that learns the ARN from reading the list.
  EOT
  type        = string

  validation {
    condition     = startswith(var.alexa_skill_id, "amzn1.ask.skill.")
    error_message = "Expected an Alexa skill id beginning with amzn1.ask.skill. — find it in the developer console under Endpoint."
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
