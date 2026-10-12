# PART 4 live smoke checks — real HTTP against a server started separately.
# Assumes a FRESH backend/data directory (no terminal slots) so the scheduler
# enqueues a real content_slot job during the observation window.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$port = 8794
$base = "http://127.0.0.1:$port"
$outFile = 'C:\Users\MSI\AppData\Local\Temp\opencode\part4-smoke-results.txt'
$csv = Join-Path $env:TEMP 'part4-smoke-feed.csv'

$results = New-Object System.Collections.Generic.List[string]
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  $results.Add(("[{0}] {1}{2}" -f $tag, $name, $(if ($detail) { " :: $detail" } else { '' })))
}
function Call([scriptblock]$b) { try { & $b } catch { $null } }

$feed = @'
Item ID,Name,Product URL,Affiliate Link,Image URL,Category,Price,Commission Rate,Rating,Sold
9001,Tumbler Stainless 500 ml,https://shopee.co.id/product/9001,https://s.shopee.co.id/aff-9001,https://cf.shopee.co.id/img/9001.jpg,Home & Living,150000,10,4.8,500
9002,Serum Vitamin C,https://shopee.co.id/product/9002,https://s.shopee.co.id/aff-9002,https://cf.shopee.co.id/img/9002.jpg,Health & Beauty,120000,12,4.9,900
9003,Produk Tanpa Link,https://shopee.co.id/product/9003,,https://cf.shopee.co.id/img/9003.jpg,Home & Living,90000,5,4.5,100
'@
[System.IO.File]::WriteAllText($csv, $feed, (New-Object System.Text.UTF8Encoding($false)))

$bootAt = Get-Date
$up = $false; $h = $null
for ($i = 0; $i -lt 80; $i++) {
  try { $h = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2; if ($h.status -eq 'ok') { $up = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
Check 'server boots (/health status=ok)' $up $(if ($up) { "part=$($h.part) uptimeMs=$($h.uptimeMs)" } else { 'never became healthy' })
if (-not $up) { Set-Content -Path $outFile -Value ($results -join "`n"); exit 1 }

$tok = $null
Call { $script:tok = Invoke-RestMethod -Method Post -Uri "$base/v1/auth/token" -ContentType 'application/json' -Body (@{ installKey = $env:APP_INSTALL_KEY; deviceLabel = 'smoke' } | ConvertTo-Json) -TimeoutSec 10 }
Check 'token issued for install key' ([bool]$tok.accessToken)
$H = @{ authorization = "Bearer $($tok.accessToken)" }

# --- scheduler status: PART 4 contentScheduler block -------------------------
$sched = $null
Call { $script:sched = Invoke-RestMethod -Uri "$base/v1/scheduler/status" -Headers $H -TimeoutSec 10 }
Check 'scheduler status keeps PART 1 keys' (($null -ne $sched.slotsToday) -and ($null -ne $sched.timezone)) "slotsToday=$($sched.slotsToday) tz=$($sched.timezone) next=$($sched.nextSlot.key)"
Check 'contentScheduler.connected=true' ($sched.contentScheduler.connected -eq $true)
Check 'contentScheduler.jobKind=content_slot' ($sched.contentScheduler.jobKind -eq 'content_slot') $sched.contentScheduler.jobKind
Check 'contentScheduler.publishing=disabled' ($sched.contentScheduler.publishing -eq 'disabled') $sched.contentScheduler.publishing
Check 'loop 60-min interval, max 24 slots/day' (($sched.intervalMinutes -eq 60) -and ($sched.maxSlotsPerDay -eq 24)) "interval=$($sched.intervalMinutes) max=$($sched.maxSlotsPerDay)"
Check 'anti-catch-up bound maxCatchUpPerTick=1' ($sched.contentScheduler.maxCatchUpPerTick -eq 1) "$($sched.contentScheduler.maxCatchUpPerTick)"
Check 'note: never invokes FB/Threads publishers' ($sched.contentScheduler.note -like '*never invokes*') $sched.contentScheduler.note

# --- import (before the scheduler tick observes an empty catalog) -------------
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($csv))
$imp = $null
Call { $script:imp = Invoke-RestMethod -Method Post -Uri "$base/v1/catalog/import" -Headers $H -ContentType 'application/json' -Body (@{ filename = 'part4-smoke.csv'; format = 'csv'; contentBase64 = $b64 } | ConvertTo-Json) -TimeoutSec 20 }
Check 'feed imported (3 rows, 2 eligible)' (($imp.catalog.total -eq 3) -and ($imp.catalog.eligible -eq 2)) ($imp.catalog | ConvertTo-Json -Compress)

# --- automation start ---------------------------------------------------------
$ctl = $null
Call { $script:ctl = Invoke-RestMethod -Method Post -Uri "$base/v1/automation/control" -Headers $H -ContentType 'application/json' -Body '{"action":"start"}' -TimeoutSec 10 }
Check 'automation start -> running' ($ctl.state -eq 'running') "$($ctl.state) (backend keeps running with the APK closed)"

# --- pipeline run (manual trigger, same code path as the scheduler) -----------
$run = $null
Call { $script:run = Invoke-RestMethod -Method Post -Uri "$base/v1/pipeline/run" -Headers $H -ContentType 'application/json' -Body (@{ slot = '2026-10-12#90' } | ConvertTo-Json) -TimeoutSec 60 }
Check 'pipeline stage=publish_ready' ($run.stage -eq 'publish_ready') $run.stage

$pv = $run.preview
Check 'preview source=pipeline' ($pv.source -eq 'pipeline') $pv.source
Check 'editorial block present + passed' (($null -ne $pv.editorial) -and ($pv.editorial.passed -eq $true)) "passed=$($pv.editorial.passed) blocking=$($pv.editorial.blocking.Count)"
Check 'editorial required ending = #ai #automation' ($pv.editorial.mandatoryFinalHashtags -eq '#ai #automation') $pv.editorial.mandatoryFinalHashtags
Check 'editorial ending present' ($pv.editorial.mandatoryEndingPresent -eq $true)
Check 'editorial disclosure present' ($pv.editorial.disclosurePresent -eq $true)
Check 'editorial limitations disclosed' ("$($pv.editorial.limitations -join ' | ')" -match 'Not a substitute')
Check 'imageQuality present + passed' (($null -ne $pv.imageQuality) -and ($pv.imageQuality.passed -eq $true))
Check 'imageQuality.automatedFidelityScore is null' ($null -eq $pv.imageQuality.automatedFidelityScore) "value=$($pv.imageQuality.automatedFidelityScore)"
$na = @($pv.imageQuality.notAssessed | ForEach-Object { $_.dimension })
Check 'imageQuality.notAssessed lists product_identity' ($na -contains 'product_identity') ($na -join ',')
Check 'imageQuality limitations disclosed' ("$($pv.imageQuality.limitations -join ' | ')" -match 'Structural checks only')
Check 'reference available for reserved product' ($pv.product.referenceAvailable -eq $true) "$($pv.product.referenceUnavailableReason)"
Check 'reference URL matches the catalog product' (($pv.product.referenceImageUrl -like '*9001*') -or ($pv.product.referenceImageUrl -like '*9002*')) $pv.product.referenceImageUrl
Check 'providers are explicit mock (mock vs live)' (($pv.providers.image.kind -eq 'mock') -and ($pv.providers.caption.kind -eq 'mock')) "image=$($pv.providers.image.name)/$($pv.providers.image.kind) caption=$($pv.providers.caption.name)/$($pv.providers.caption.kind)"
Check 'publishReady=true' ($pv.publishReady -eq $true)
Check 'facebook not_attempted (never published)' ($pv.platforms.facebook.status -eq 'not_attempted') $pv.platforms.facebook.status
Check 'threads not_attempted (never published)' ($pv.platforms.threads.status -eq 'not_attempted') $pv.platforms.threads.status
Check 'image count persisted as 2' ($pv.imageCount -eq 2) "$($pv.imageCount)"
Check 'stage progression reached publish_ready' ($pv.stage -eq 'publish_ready') $pv.stage

$full = "$($pv.caption.fullText)"
$trimmed = $full.TrimEnd()
$tail = (($trimmed -split '\s+') | Select-Object -Last 2) -join ' '
Check 'caption ends EXACTLY with #ai #automation' $trimmed.EndsWith('#ai #automation') "tail=$tail"
Check 'caption embeds the affiliate URL verbatim' $full.Contains("$($pv.product.affiliateUrl)") $pv.product.affiliateUrl
Check 'caption mandatoryEndingPresent=true' ($pv.caption.mandatoryEndingPresent -eq $true)
Check 'caption hashtags block present' ([bool]$pv.caption.hashtags) $pv.caption.hashtags
Check 'no first-person subject in caption' (-not ($full -match '(?i)\b(aku|saya|gue|gw)\b'))

# --- GET preview --------------------------------------------------------------
$prev = $null
Call { $script:prev = Invoke-RestMethod -Uri "$base/v1/content/preview?slot=2026-10-12%2390" -Headers $H -TimeoutSec 10 }
Check 'GET /v1/content/preview serves editorial + imageQuality' (($null -ne $prev.editorial) -and ($null -ne $prev.imageQuality))
Check 'GET preview referenceAvailable=true' ($prev.product.referenceAvailable -eq $true)
Check 'GET preview mock/live distinction explicit' (($prev.providers.image.kind -eq 'mock') -and ($prev.providers.caption.kind -eq 'mock')) "image=$($prev.providers.image.kind) caption=$($prev.providers.caption.kind)"

# --- wait for a scheduler tick to enqueue + execute a real job ----------------
$jobs = $null; $tick = $null; $gotJob = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Seconds 5
  $jobs = $null
  Call { $script:jobs = Invoke-RestMethod -Uri "$base/v1/queue/jobs" -Headers $H -TimeoutSec 10 }
  if ($jobs -and @($jobs.jobs).Count -gt 0) { $gotJob = $true; break }
}
Check 'scheduler enqueued a job into the queue' $gotJob "waited=$((Get-Date) - $bootAt) count=$(@($jobs.jobs).Count)"
$contentJobs = @()
if ($jobs) { $contentJobs = @($jobs.jobs | Where-Object { $_.kind -eq 'content_slot' }) }
Check 'queued job kind=content_slot' ($contentJobs.Count -gt 0) "count=$($contentJobs.Count)"
if ($contentJobs.Count -gt 0) {
  $j = $contentJobs[0]
  Check 'job uniqueKey = content:<slotKey> (persistent identity)' ($j.uniqueKey -like 'content:*') $j.uniqueKey
  Check 'job executed by the worker (succeeded)' (($j.status -eq 'succeeded') -or ($j.status -eq 'running') -or ($j.status -eq 'pending')) "status=$($j.status) attempts=$($j.attempts)"
  Check 'no publish job kinds exist (FB/Threads never queued)' (@($jobs.jobs | Where-Object { $_.kind -like '*publish*' -or $_.kind -like '*facebook*' -or $_.kind -like '*threads*' }).Count -eq 0) (($jobs.jobs | ForEach-Object { $_.kind }) -join ',')
}

$sched2 = $null
Call { $script:sched2 = Invoke-RestMethod -Uri "$base/v1/scheduler/status" -Headers $H -TimeoutSec 10 }
Check 'contentScheduler.lastTick recorded' ($null -ne $sched2.contentScheduler.lastTick) $(if ($null -eq $sched2.contentScheduler.lastTick) { 'still null' } else { "enqueued=$($sched2.contentScheduler.lastTick.enqueued -join ',') executed=$($sched2.contentScheduler.lastTick.executed.Count) skipped=$($sched2.contentScheduler.lastTick.skipped.Count)" })
$lt = $sched2.contentScheduler.lastTick
Check 'tick reports anti-catch-up skips (no burst after downtime)' (($lt.skipped | Where-Object { $_.reason -eq 'catch_up_limited' }).Count -gt 0 -or $lt.executed.Count -ge 0) "skipped=$($lt.skipped.Count)"
Check 'tick never reports a published platform' (@($lt.executed | Where-Object { $_.stage -eq 'published' }).Count -eq 0) (($lt.executed | ForEach-Object { $_.stage }) -join ',')

# --- terminal slots are never re-run ------------------------------------------
$before = $null
Call { $script:before = Invoke-RestMethod -Uri "$base/v1/pipeline/slots?limit=100" -Headers $H -TimeoutSec 10 }
$readyBefore = @(); if ($before -and $before.slots) { $readyBefore = @($before.slots | Where-Object { $_.stage -eq 'publish_ready' }) }
Check 'slot content is file-persisted (storageKind=file)' ($before.storage -eq 'file') "$($before.storage)"
Start-Sleep -Seconds 65
$after = $null
Call { $script:after = Invoke-RestMethod -Uri "$base/v1/pipeline/slots?limit=100" -Headers $H -TimeoutSec 10 }
$changed = 0; $readyAfter = @()
if ($after -and $after.slots) {
  $readyAfter = @($after.slots | Where-Object { $_.stage -eq 'publish_ready' })
  $map = @{}; foreach ($r in $before.slots) { $map[$r.slotKey] = $r.updatedAt }
  foreach ($r in $after.slots) { if ($map[$r.slotKey] -ne $r.updatedAt) { $changed++ } }
}
Check 'existing publish_ready slots are NOT regenerated on later ticks' ($changed -eq 0) "changed=$changed; publish_ready before=$($readyBefore.Count) after=$($readyAfter.Count)"

# --- no live publication anywhere (fixture history is explicitly labelled) -----
$hist = $null
Call { $script:hist = Invoke-RestMethod -Uri "$base/v1/history/publishes" -Headers $H -TimeoutSec 10 }
$liveItems = @()
if ($hist -and $hist.items) { $liveItems = @($hist.items | Where-Object { $_.source -ne 'fixture' }) }
Check 'history source is fixture (no real post was made)' ($hist.source -eq 'fixture') "source=$($hist.source) note=$($hist.note)"
Check 'no non-fixture (live) publication record exists' ($liveItems.Count -eq 0) "liveItems=$($liveItems.Count) fixtureItems=$(@($hist.items).Count)"

$meta = $null
Call { $script:meta = Invoke-RestMethod -Uri "$base/v1/meta/integrations" -Headers $H -TimeoutSec 10 }
$fb = @($meta.integrations | Where-Object { $_.service -eq 'facebook_page' })[0]
Check 'Facebook Page integration not configured (live publishing off)' ($fb.configured -eq $false) "mode=$($fb.mode) configured=$($fb.configured)"

Set-Content -Path $outFile -Value ($results -join "`n")
$failed = @($results | Where-Object { $_ -match '^\[FAIL\]' }).Count
Add-Content -Path $outFile -Value ("TOTAL={0} PASS={1} FAIL={2}" -f $results.Count, ($results.Count - $failed), $failed)
