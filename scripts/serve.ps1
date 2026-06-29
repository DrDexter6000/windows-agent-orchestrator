# scripts/serve.ps1
#
# Start opencode serve with all provider API keys injected.
#
# opencode.json references keys as {env:XXX_API_KEY}. If the serve process
# was started from a context that did not inherit those env vars (autostart,
# spawned by another tool), it cannot read the keys -> every provider call
# returns 401 -> WAO hangs in submitted then times out. This was the root
# cause of the 2026-06-17 GLM 401 incident.
#
# This script reads keys from the Windows User registry (no secret on disk)
# and injects them into the serve process, so the keys are present regardless
# of how the shell was launched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/serve.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/serve.ps1 -Port 4298

param(
  [string]$Hostname = "127.0.0.1",
  [int]$Port = 4298
)

# Provider keys referenced by opencode.json as {env:XXX}.
# To add a provider, append its env var name to this list.
$keyNames = @("ZHIPU_API_KEY", "KIMI_API_KEY", "DEEPSEEK_API_KEY")
$loaded = @{}
foreach ($name in $keyNames) {
  $val = [System.Environment]::GetEnvironmentVariable($name, "User")
  if (-not $val) {
    Write-Warning "[!] $name not found in User env - workers on that provider will 401."
  }
  else {
    $loaded[$name] = $val
    Write-Host "[ok] $name loaded"
  }
}

# Kill any process already holding the target port.
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $oldPid = $existing.OwningProcess
  Write-Host "Port $Port held by PID $oldPid, killing..."
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Inject keys into this process env, then start serve.
# opencode is a .cmd shim on Windows; Start-Process cannot call "opencode"
# directly ("%1 is not a valid Win32 application"), so go through cmd.exe /c.
foreach ($name in $loaded.Keys) {
  Set-Item -Path "Env:$name" -Value $loaded[$name]
}
Write-Host "Starting opencode serve on ${Hostname}:${Port}..."
$proc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c", "opencode", "serve", "--hostname", $Hostname, "--port", $Port `
  -PassThru -WindowStyle Hidden

# Wait for serve to listen (up to ~15s). Use Get-NetTCPConnection instead of
# Invoke-RestMethod to avoid blocking the whole script.
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) {
    Write-Error "opencode serve exited early (code $($proc.ExitCode)). Check opencode config."
    exit 1
  }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $ready = $true
    break
  }
}

if ($ready) {
  Write-Host "[ok] opencode serve ready (PID $($proc.Id)) on http://${Hostname}:${Port}"
  Write-Host "     provider keys injected. WAO workers can now call GLM/Kimi/DeepSeek."
}
else {
  Write-Error "[!] serve did not become ready within 15s. Check opencode config."
  exit 1
}
