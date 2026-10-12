<#
  db.ps1 — control the PART 5 local PostgreSQL test cluster.

  The cluster exists ONLY for database integration tests. Production connects
  to a managed PostgreSQL through DATABASE_URL and never uses this script.

  Why it exists at all: PostgreSQL refuses to run under an elevated Windows
  token. When this script is started from an elevated shell it creates (once)
  a throwaway unprivileged local account with a random password and launches
  the server under it, while the calling shell keeps acting as a normal TCP
  client. On a non-elevated shell everything runs inline.

  All generated material lives in the gitignored backend/tmp/ folder:
    pg-creds.json   — throwaway cluster login (never committed)
    pg-helper.json  — throwaway local account (never committed)
    pg-status.json  — readiness + connection URL for client processes

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/db.ps1 -Action start [-Fresh]
    powershell -ExecutionPolicy Bypass -File scripts/db.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File scripts/db.ps1 -Action url
    powershell -ExecutionPolicy Bypass -File scripts/db.ps1 -Action stop
    powershell -ExecutionPolicy Bypass -File scripts/db.ps1 -Action remove-helper
#>
param(
  [ValidateSet('start', 'stop', 'status', 'url', 'remove-helper')]
  [string]$Action = 'status',
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $backend 'tmp'
$credsFile = Join-Path $tmp 'pg-creds.json'
$statusFile = Join-Path $tmp 'pg-status.json'
$stopFile = Join-Path $tmp 'pg-stop.flag'
$helperFile = Join-Path $tmp 'pg-helper.json'
$serverScript = Join-Path $PSScriptRoot 'pg-lifecycle.mjs'
$stdoutLog = Join-Path $tmp 'pg-stdout.log'
$stderrLog = Join-Path $tmp 'pg-stderr.log'
$helperName = 'autopilot_pg_test'
$nodeExe = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $tmp -Force | Out-Null

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-RandomPassword([int]$Length = 24) {
  $chars = (48..57) + (65..90) + (97..122)
  return -join (($chars | Get-Random -Count $Length) | ForEach-Object { [char]$_ })
}

function Get-PgCreds {
  if (Test-Path $credsFile) {
    $parsed = Get-Content $credsFile -Raw | ConvertFrom-Json
    if ($parsed.user -and $parsed.password -and $parsed.port -and $parsed.database) { return $parsed }
  }
  $fresh = [pscustomobject]@{
    user     = 'autopilot'
    password = New-RandomPassword
    database = 'autopilot_test'
    port     = 55432
  }
  # UTF-8 without BOM: the file is read back by Node's JSON.parse.
  [System.IO.File]::WriteAllText($credsFile, ($fresh | ConvertTo-Json), ([System.Text.UTF8Encoding]::new($false)))
  return $fresh
}

function Get-Status {
  if (-not (Test-Path $statusFile)) { return $null }
  try { return (Get-Content $statusFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-Port([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(1000)
    if ($ok) { $c.Close() }
    return $ok
  } catch { return $false }
}

# Creates (or re-passwords) the unprivileged account and grants it exactly the
# access the server process needs: read the repo/node_modules, write tmp/.
function Ensure-Helper {
  if (Test-Path $helperFile) {
    $h = Get-Content $helperFile -Raw | ConvertFrom-Json
    if ($h.user -and $h.password -and (Get-LocalUser -Name $h.user -ErrorAction SilentlyContinue)) {
      return $h
    }
  }
  $password = New-RandomPassword
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  if (Get-LocalUser -Name $helperName -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $helperName -Password $secure
  } else {
    New-LocalUser -Name $helperName -Password $secure -AccountNeverExpires `
      -PasswordNeverExpires -Description 'Shopee Affiliate Autopilot PART 5 PostgreSQL test harness' | Out-Null
  }
  $account = Get-LocalUser -Name $helperName -ErrorAction Stop
  $sid = $account.SID.Value
  $repo = Split-Path -Parent $backend

  # Inheritance flags only: no directory walk, so these are cheap and idempotent.
  # icacls needs the '*' prefix to accept a raw SID, and native tools may write
  # warnings to stderr — that must not abort the script.
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  icacls $repo /grant "*$($sid):(OI)(CI)RX" /Q | Out-Null
  icacls $backend /grant "*$($sid):(OI)(CI)RX" /Q | Out-Null
  icacls $tmp /grant "*$($sid):(OI)(CI)F" /Q | Out-Null
  icacls (Join-Path $backend 'node_modules') /grant "*$($sid):(OI)(CI)RX" /Q | Out-Null
  $ErrorActionPreference = $previousEap

  $record = [pscustomobject]@{ user = $helperName; password = $password; sid = $sid }
  [System.IO.File]::WriteAllText($helperFile, ($record | ConvertTo-Json), ([System.Text.UTF8Encoding]::new($false)))
  return $record
}

function Start-Cluster {
  # -Fresh means FRESH: tear down a running cluster first so the data directory
  # is really recreated instead of being silently reused.
  if ($Fresh -and (Get-Status)) { Stop-Cluster }
  $creds = Get-PgCreds
  $existing = Get-Status
  if ($existing -and (Test-Port $existing.port)) {
    Write-Output "already running on 127.0.0.1:$($existing.port)/$($existing.database)"
    return
  }

  Remove-Item $stopFile -ErrorAction SilentlyContinue
  Remove-Item $statusFile -ErrorAction SilentlyContinue
  Remove-Item $stdoutLog -ErrorAction SilentlyContinue
  Remove-Item $stderrLog -ErrorAction SilentlyContinue

  $argString = '"' + $serverScript + '"'
  if ($Fresh) { $argString += ' --fresh' }

  $proc = $null
  if (Test-Elevated) {
    $helper = Ensure-Helper
    $secure = ConvertTo-SecureString $helper.password -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$($helper.user)", $secure)
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $argString -WorkingDirectory $backend `
      -Credential $cred -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    Write-Output "starting PostgreSQL under unprivileged account '$($helper.user)' (elevated shell)..."
  } else {
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $argString -WorkingDirectory $backend `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    Write-Output 'starting PostgreSQL...'
  }

  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $status = Get-Status
    if ($status -and (Test-Port $status.port)) {
      Write-Output "ready on 127.0.0.1:$($status.port)/$($status.database)"
      return
    }
    if ($proc) {
      $exited = $false
      try { $exited = $proc.HasExited } catch { $exited = $false }
      if ($exited) { break }
    }
  }

  Write-Output '--- pg-stdout.log ---'
  Get-Content $stdoutLog -ErrorAction SilentlyContinue | Select-Object -Last 20
  Write-Output '--- pg-stderr.log ---'
  Get-Content $stderrLog -ErrorAction SilentlyContinue | Select-Object -Last 20
  throw 'PostgreSQL did not become ready within 120s.'
}

function Stop-Cluster {
  $status = Get-Status
  if (-not $status) {
    Write-Output 'not running'
    return
  }
  Set-Content -Path $stopFile -Value 'stop' -Encoding ascii
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Status)) { Write-Output 'stopped'; return }
  }
  Write-Output 'stop flag ignored — terminating the server process'
  try { Stop-Process -Id $status.pid -Force -ErrorAction Stop } catch { }
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Status)) { Write-Output 'stopped (terminated)'; return }
  }
  throw 'PostgreSQL did not stop.'
}

function Remove-Helper {
  if (-not (Test-Path $helperFile)) { Write-Output 'no helper account recorded'; return }
  $h = Get-Content $helperFile -Raw | ConvertFrom-Json
  if (Get-LocalUser -Name $h.user -ErrorAction SilentlyContinue) {
    Remove-LocalUser -Name $h.user
  }
  Remove-Item $helperFile -ErrorAction SilentlyContinue
  Write-Output "removed local account '$($h.user)'"
}

switch ($Action) {
  'start' { Start-Cluster }
  'stop' { Stop-Cluster }
  'status' {
    $status = Get-Status
    if ($status -and (Test-Port $status.port)) {
      Write-Output "ready on 127.0.0.1:$($status.port)/$($status.database) (pid $($status.pid))"
    } elseif ($status) {
      Write-Output 'status file present but port not reachable'
      exit 1
    } else {
      Write-Output 'not running'
      exit 1
    }
  }
  'url' {
    $status = Get-Status
    if (-not $status) { throw 'cluster is not running' }
    Write-Output $status.url
  }
  'remove-helper' { Remove-Helper }
}
