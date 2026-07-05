$ErrorActionPreference = "Stop"

function Read-EnvFile($Path) {
  $envMap = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $envMap[$line.Substring(0, $idx)] = $line.Substring($idx + 1)
  }
  return $envMap
}

$envMap = Read-EnvFile ".env.local"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  throw "Set SUPABASE_ACCESS_TOKEN first. Create it in Supabase Account Settings > Access Tokens."
}

if (-not $envMap["SUPABASE_PROJECT_REF"]) {
  throw "Set SUPABASE_PROJECT_REF in .env.local before deploying functions."
}

function Add-SecretArg($Name, $Value) {
  if ($null -ne $Value -and "$Value".Trim()) {
    $script:secretArgs += "$Name=$Value"
  }
}

function Add-ServiceRoleSecret($Value) {
  $clean = "$Value".Trim()
  if (-not $clean) { return }
  if ($clean.Length -lt 80 -and -not $clean.StartsWith("sb_secret_")) {
    Write-Warning "Skipping SERVICE_ROLE_KEY because the local value does not look like a real Supabase service-role key."
    return
  }
  Add-SecretArg "SERVICE_ROLE_KEY" $clean
}

npx supabase link --project-ref $envMap["SUPABASE_PROJECT_REF"]

$secretArgs = @()
Add-SecretArg "SUPABASE_URL" $envMap["SUPABASE_URL"]
Add-SecretArg "SUPABASE_ANON_KEY" $envMap["SUPABASE_ANON_KEY"]
Add-ServiceRoleSecret $envMap["SUPABASE_SERVICE_ROLE_KEY"]
Add-SecretArg "PAYMENT_PROVIDER" $(if ($envMap["PAYMENT_PROVIDER"]) { $envMap["PAYMENT_PROVIDER"] } else { "paymongo" })
Add-SecretArg "PAYMONGO_SECRET_KEY" $envMap["PAYMONGO_SECRET_KEY"]
Add-SecretArg "PAYMENT_SUCCESS_URL" $envMap["PAYMENT_SUCCESS_URL"]
Add-SecretArg "PAYMENT_CANCEL_URL" $envMap["PAYMENT_CANCEL_URL"]
Add-SecretArg "PAYMENT_WEBHOOK_SECRET" $envMap["PAYMENT_WEBHOOK_SECRET"]
Add-SecretArg "RESEND_API_KEY" $envMap["RESEND_API_KEY"]
Add-SecretArg "EMAIL_FROM" $envMap["EMAIL_FROM"]
Add-SecretArg "APP_ADMIN_URL" $envMap["APP_ADMIN_URL"]
Add-SecretArg "APP_LOGO_URL" $envMap["APP_LOGO_URL"]
Add-SecretArg "APP_LOCATION" $envMap["APP_LOCATION"]
Add-SecretArg "TELEGRAM_BOT_TOKEN" $envMap["TELEGRAM_BOT_TOKEN"]
Add-SecretArg "TELEGRAM_CHAT_ID" $envMap["TELEGRAM_CHAT_ID"]
Add-SecretArg "GOOGLE_VISION_API_KEY" $envMap["GOOGLE_VISION_API_KEY"]
Add-SecretArg "OCRSPACE_API_KEY" $envMap["OCRSPACE_API_KEY"]

if ($secretArgs.Count -gt 0) {
  npx supabase secrets set @secretArgs
}

npx supabase functions deploy create-payment-session --no-verify-jwt
npx supabase functions deploy payment-webhook --no-verify-jwt
npx supabase functions deploy sync-payment-session --no-verify-jwt
npx supabase functions deploy verify-gcash-receipt --no-verify-jwt
npx supabase functions deploy manage-account --no-verify-jwt
npx supabase functions deploy send-confirmation-email --no-verify-jwt
npx supabase functions deploy send-reschedule-email --no-verify-jwt
npx supabase functions deploy send-telegram-notification --no-verify-jwt
npx supabase functions deploy integration-status --no-verify-jwt

Write-Host "Edge Functions deployed."
