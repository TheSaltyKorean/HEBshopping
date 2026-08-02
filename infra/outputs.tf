output "alexa_lambda_arn" {
  description = "Paste this into the Alexa developer console as the skill's Default Endpoint."
  value       = aws_lambda_function.alexa.arn
}

output "session_table" {
  description = "Pass to `npm run push:session -- --table <this>` after every login."
  value       = aws_dynamodb_table.session.name
}

output "mcp_url" {
  description = "MCP endpoint, when enable_mcp_url is true. Needed only for Gemini Spark."
  value       = var.enable_mcp_url ? aws_lambda_function_url.mcp[0].function_url : null
}

output "mcp_token_parameter" {
  description = "SSM parameter holding the MCP bearer token. The value is never an output."
  value       = aws_ssm_parameter.mcp_token.name
}

output "next_steps" {
  description = "What to do once apply finishes."
  value       = <<-EOT

    1. Alexa developer console → Endpoint → AWS Lambda ARN:
         ${aws_lambda_function.alexa.arn}

    2. Upload the H-E-B session (the Lambda cannot read your laptop):
         npm run push:session -- --table ${aws_dynamodb_table.session.name} --region ${var.region}

    3. Say: "Alexa, ask my grocery list what is on my list"

    Re-run step 2 after every `npm run login` — roughly monthly, when cookies expire.
  EOT
}
