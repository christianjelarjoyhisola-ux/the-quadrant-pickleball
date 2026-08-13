$ErrorActionPreference = "Stop"

function Read-EnvFile($Path) {
  $envMap = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $envMap[$line.Substring(0, $idx)] = $line.Substring($idx + 1)
  }
  return $envMap
}

$envPath = Join-Path $PSScriptRoot "..\.env.local"
if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Create .env.local from .env.example and add SUPABASE_PROJECT_REF plus TELEGRAM_BOT_TOKEN first."
}

$envMap = Read-EnvFile $envPath
$projectRef = "$($envMap['SUPABASE_PROJECT_REF'])".Trim()
$botToken = "$($envMap['TELEGRAM_BOT_TOKEN'])".Trim()
$registrationCode = "$($envMap['TELEGRAM_REGISTRATION_CODE'])".Trim()
$webhookSecret = "$($envMap['TELEGRAM_WEBHOOK_SECRET'])".Trim()

if (-not $projectRef) { throw "SUPABASE_PROJECT_REF is missing from .env.local." }
if (-not $botToken) { throw "TELEGRAM_BOT_TOKEN is missing from .env.local." }
if (-not $registrationCode) { throw "TELEGRAM_REGISTRATION_CODE is missing from .env.local." }
if (-not $webhookSecret) { throw "TELEGRAM_WEBHOOK_SECRET is missing from .env.local." }

if ($registrationCode -notmatch '^[A-Za-z0-9_-]{8,64}$') {
  throw "TELEGRAM_REGISTRATION_CODE must contain 8-64 letters, numbers, underscores, or hyphens."
}
if ($webhookSecret -notmatch '^[A-Za-z0-9_-]{16,128}$') {
  throw "TELEGRAM_WEBHOOK_SECRET must contain 16-128 letters, numbers, underscores, or hyphens."
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $projectRoot
try {
  npx supabase link --project-ref $projectRef
  if ($LASTEXITCODE -ne 0) { throw "Could not link the Supabase project." }

  npx supabase db push
  if ($LASTEXITCODE -ne 0) { throw "Could not apply the Telegram chat subscription migration." }

  npx supabase secrets set `
    "TELEGRAM_BOT_TOKEN=$botToken" `
    "TELEGRAM_WEBHOOK_SECRET=$webhookSecret" `
    "TELEGRAM_REGISTRATION_CODE=$registrationCode"
  if ($LASTEXITCODE -ne 0) { throw "Could not set Telegram secrets." }

  npx supabase functions deploy telegram-webhook --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw "Could not deploy telegram-webhook." }
  npx supabase functions deploy send-telegram-notification --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw "Could not deploy send-telegram-notification." }
  npx supabase functions deploy verify-gcash-receipt --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw "Could not deploy verify-gcash-receipt." }
  npx supabase functions deploy integration-status --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw "Could not deploy integration-status." }

  $webhookUrl = "https://$projectRef.supabase.co/functions/v1/telegram-webhook"
  $webhookBody = @{
    url = $webhookUrl
    secret_token = $webhookSecret
    allowed_updates = @("message", "edited_message", "channel_post", "edited_channel_post")
    drop_pending_updates = $false
  } | ConvertTo-Json -Depth 4

  $telegramResult = Invoke-RestMethod `
    -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
    -Method Post `
    -ContentType "application/json" `
    -Body $webhookBody
  if (-not $telegramResult.ok) { throw "Telegram rejected the webhook registration." }

  $bot = Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getMe" -Method Get
  $botUsername = $bot.result.username
  Write-Host "Telegram webhook is active for @$botUsername."
  Write-Host "Private setup link: https://t.me/$botUsername`?start=$registrationCode"
  Write-Host "Open that link in the Telegram chat that should receive booking alerts, then press Start."
} finally {
  Pop-Location
}

