<#
  test-db.ps1 — run the PART 5 PostgreSQL integration suite.

  What it does, in order:
    1. starts an ISOLATED local PostgreSQL (scripts/db.ps1) — a throwaway
       cluster on 127.0.0.1:55432, recreated by default so every run begins
       from an empty database;
    2. exports TEST_DATABASE_URL / DATABASE_URL for the suite;
    3. runs `vitest --config vitest.db.config.ts`; the suite's global setup
       applies the committed migration chain (drizzle-kit migrate) first, so
       this step doubles as a from-scratch migration test;
    4. runs `npm run db:status` (journal vs applied records, drift detection)
       and `npm run db:verify` (src/db/schema.ts vs the live catalog);
    5. stops the cluster unless -KeepCluster is given.

  It never reads production credentials: the only URL used is the one written
  by the cluster harness into the gitignored backend/tmp/pg-status.json.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/test-db.ps1
    powershell -ExecutionPolicy Bypass -File scripts/test-db.ps1 -Reuse
    powershell -ExecutionPolicy Bypass -File scripts/test-db.ps1 -KeepCluster
#>
param(
  # Reuse an existing cluster instead of recreating it from scratch.
  [switch]$Reuse,
  # Leave the cluster running (handy for inspecting rows after a failure).
  [switch]$KeepCluster,
  # Extra arguments forwarded to vitest (e.g. -TestArgs '-t','lease').
  [string[]]$TestArgs = @()
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$dbScript = Join-Path $PSScriptRoot 'db.ps1'
$statusFile = Join-Path $backend 'tmp/pg-status.json'
$failures = New-Object System.Collections.ArrayList

Write-Output '==> starting isolated PostgreSQL (throwaway cluster, no production credentials)'
$dbArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dbScript, '-Action', 'start')
if (-not $Reuse) { $dbArgs += '-Fresh' }
& powershell @dbArgs
if ($LASTEXITCODE -ne 0) {
  Write-Output 'BLOCKED: could not start the local PostgreSQL cluster.'
  exit 2
}
if (-not (Test-Path $statusFile)) {
  Write-Output "BLOCKED: missing $statusFile after cluster start."
  exit 2
}
$url = (Get-Content $statusFile -Raw | ConvertFrom-Json).url
if (-not $url) {
  Write-Output 'BLOCKED: cluster reported no connection URL.'
  exit 2
}
# The suite and the CLIs read these; they only ever point at the local cluster.
$env:TEST_DATABASE_URL = $url
$env:DATABASE_URL = $url
Write-Output "cluster ready (URL held in the environment only, never printed)."

try {
  Write-Output ''
  Write-Output '==> integration tests (vitest.db.config.ts)'
  if ($TestArgs.Count -gt 0) { & npx vitest run --config vitest.db.config.ts @TestArgs }
  else { & npx vitest run --config vitest.db.config.ts }
  $code = $LASTEXITCODE
  if ($code -ne 0) { $failures.Add("integration tests (exit $code)") | Out-Null }

  Write-Output ''
  Write-Output '==> db:status (migrations applied, no drift)'
  & npm run db:status
  $code = $LASTEXITCODE
  if ($code -ne 0) { $failures.Add("db:status (exit $code)") | Out-Null }

  Write-Output ''
  Write-Output '==> db:verify (src/db/schema.ts vs live database)'
  & npm run db:verify
  $code = $LASTEXITCODE
  if ($code -ne 0) { $failures.Add("db:verify (exit $code)") | Out-Null }
}
finally {
  if (-not $KeepCluster) {
    Write-Output ''
    Write-Output '==> stopping the test cluster'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $dbScript -Action stop
  } else {
    Write-Output ''
    Write-Output '==> cluster left running (-KeepCluster); stop it with scripts/db.ps1 -Action stop'
  }
}

Write-Output ''
if ($failures.Count -eq 0) {
  Write-Output 'RESULT: PASS - migrations, schema verification and the PostgreSQL integration suite.'
  exit 0
}
Write-Output 'RESULT: FAIL'
foreach ($failure in $failures) { Write-Output "  - $failure" }
exit 1
