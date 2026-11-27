<#
SCRUM-199: one command for the load-test demo at the exam (SCRUM-196). See loadtest/EKSAMEN.md.

  .\loadtest\stress.ps1 -Check     # 2-3 min trial with a few users: run it the day before the exam
  .\loadtest\stress.ps1            # the demo: bots + HTTP load (+ kubectl get hpa -w) in their own windows
  .\loadtest\stress.ps1 -Cleanup   # delete all loadbot_ users and their stats (needs a Slopster Admin login)

The bot password is shared by the group in OpenBao (kv/quiz/loadtest -> bot-password). The first run asks
for it and keeps it in $HOME\.slopster-loadtest, never in git. It reaches k6 as the environment variable
BOT_PASSWORD (k6 reads system environment variables), so it is never on a command line.

Only one person at a time: every run uses the same bot names.
Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only, so 5.1 reads it without a BOM.
#>
param(
    [switch]$Check,
    [switch]$Cleanup,
    [int]$Bots = 50,
    [int]$Rate = 60,
    [string]$RampUp = '1m',
    [string]$Duration = '5m',
    [string]$BaseUrl = 'https://quiz.munkcloud.dk'
)

$ErrorActionPreference = 'Stop'
$gitops = Split-Path $PSScriptRoot -Parent   # k6 runs from gitops/, so http.js saves to loadtest/results/
Set-Location $gitops

function Find-K6 {
    $cmd = Get-Command k6 -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = 'C:\Program Files\k6\k6.exe'
    if (Test-Path $default) { return $default }
    throw 'k6 not found. Install it with: winget install GrafanaLabs.k6   (then open a new terminal)'
}

function ConvertTo-Plain([Security.SecureString]$secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-BotPassword {
    $file = Join-Path $HOME '.slopster-loadtest'
    if (Test-Path $file) {
        $saved = (Get-Content $file -Raw).Trim()
        if ($saved.Length -ge 8) { return $saved }
    }
    Write-Host 'Bot password: copy it from OpenBao, kv/quiz/loadtest -> bot-password.' -ForegroundColor Yellow
    $plain = ConvertTo-Plain (Read-Host 'Paste the bot password' -AsSecureString)
    if ($plain.Length -lt 8) { throw 'The bot password must be at least 8 characters.' }
    Set-Content -Path $file -Value $plain -NoNewline
    Write-Host "Saved in $file (not in git). Delete the file if the password in OpenBao changes."
    return $plain
}

# Runs k6 in this window and returns $true when all thresholds held (exit code 0).
function Invoke-K6([string]$script, [hashtable]$vars) {
    $k6args = @('run')
    foreach ($k in $vars.Keys) { $k6args += @('-e', "$k=$($vars[$k])") }
    $k6args += $script
    & $script:k6 @k6args | Out-Host   # to the screen, not into the function's return value
    return ($LASTEXITCODE -eq 0)
}

# Starts a command in its own PowerShell window that stays open, in gitops/, with the same environment.
function Start-Window([string]$title, [string]$command) {
    $full = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$gitops'; $command"
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $full) | Out-Null
}

$script:k6 = Find-K6

if ($Cleanup) {
    Write-Host 'Cleanup: log in with a Slopster account that has the Admin role.' -ForegroundColor Yellow
    $env:ADMIN_USER = Read-Host 'Admin user name'
    $env:ADMIN_PASSWORD = ConvertTo-Plain (Read-Host 'Admin password' -AsSecureString)
    try { $ok = Invoke-K6 'loadtest/cleanup.js' @{ BASE_URL = $BaseUrl } }
    finally { Remove-Item Env:ADMIN_USER, Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue }
    if ($ok) { Write-Host 'Cleanup done.' -ForegroundColor Green } else { Write-Host 'Cleanup failed, see above.' -ForegroundColor Red }
    return
}

$env:BOT_PASSWORD = Get-BotPassword

if ($Check) {
    Write-Host "`n[1/2] HTTP load, small: 2 users, 5 requests/s (about 1 min)" -ForegroundColor Cyan
    $httpOk = Invoke-K6 'loadtest/http.js' @{ BASE_URL = $BaseUrl; USERS = 2; RATE = 5; RAMP_UP = '10s'; DURATION = '20s' }
    Write-Host "`n[2/2] Bots, small: 2 bots in one lobby (about 1-2 min)" -ForegroundColor Cyan
    $botsOk = Invoke-K6 'loadtest/bots.js' @{ BASE_URL = $BaseUrl; BOTS = 2; BOTS_PER_LOBBY = 2; RAMP_UP = '5s'; DURATION = '1m' }
    Write-Host ''
    if ($httpOk -and $botsOk) { Write-Host 'CHECK OK: both tests work. You are ready for the demo.' -ForegroundColor Green }
    else { Write-Host "CHECK FAILED: http.js ok=$httpOk, bots.js ok=$botsOk. See loadtest/EKSAMEN.md, 'Hvis noget fejler'." -ForegroundColor Red }
    return
}

# The demo. Bots first (they log in during RAMP_UP), the HTTP load in its own window next to them.
$users = [Math]::Max(20, [Math]::Ceiling($Rate / 9))   # the edge allows about 9 requests/s per user
Start-Window 'Slopster bots (SCRUM-197)' "& '$($script:k6)' run -e BASE_URL=$BaseUrl -e BOTS=$Bots -e RAMP_UP=$RampUp -e DURATION=$Duration loadtest/bots.js"
Start-Window 'Slopster HTTP load (SCRUM-198)' "& '$($script:k6)' run -e BASE_URL=$BaseUrl -e USERS=$users -e RATE=$Rate -e RAMP_UP=$RampUp -e DURATION=$Duration loadtest/http.js"
if (Get-Command kubectl -ErrorAction SilentlyContinue) {
    Start-Window 'Slopster HPA' 'kubectl -n quiz get hpa -w'
} else {
    Write-Host 'kubectl not found: watch the pods in Grafana instead.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "Started: $Bots bots + $Rate requests/s ($users users), ramp-up $RampUp, plateau $Duration." -ForegroundColor Green
Write-Host 'Now open Grafana, dashboard "Slopster Autoscaling", and watch the pods go from 2 towards 5.'
Write-Host 'The HTTP result is saved in loadtest/results/ when its window says "Thresholds".'
Write-Host 'After the demo the pods scale down again in about 2 minutes.'
