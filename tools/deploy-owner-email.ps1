param([string]$ProjectRef = "mjwmvlhzjkaduwdtfwiu")
$ErrorActionPreference = "Stop"
if ($ProjectRef -notmatch '^[a-z0-9]{20}$') { throw "Use the intended Supabase project reference." }
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $projectRoot
try {
  # Apply the reviewed migration and configure secrets separately, as documented.
  # No local environment/provider secrets are uploaded by this script.
  foreach ($functionName in @(
    "owner-email-notifications",
    "integration-status",
    "verify-gcash-receipt",
    "send-telegram-notification",
    "telegram-webhook"
  )) {
    npx supabase functions deploy $functionName --project-ref $ProjectRef --no-verify-jwt
    if ($LASTEXITCODE -ne 0) { throw "Deployment failed for $functionName. Frontend release must wait." }
  }
  Write-Host "Targeted functions deployed. Complete and verify the queue scheduler before publishing the frontend."
} finally {
  Pop-Location
}
