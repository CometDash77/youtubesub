[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh-community'),
  [string]$AppRoot  = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked',
  [string]$ResourcesRoot = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources'
)
$ErrorActionPreference = 'Continue'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Resolve-Path (Join-Path (Get-Location) 'harness/scripts')).Path }
$metrics   = Join-Path $scriptDir 'session-metrics.cjs'

$results = New-Object System.Collections.ArrayList
function Add-Result([string]$name, [bool]$ok, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = $detail })
}

# ---- locate the newest session log + its projection cache -------------------
$log = Get-ChildItem -LiteralPath (Join-Path $DshHome 'sessions') -Recurse -File -Force -Filter 'session.v3.jsonl.zstd' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
$sessionId = $null; $proj = $null; $mj = $null
if ($log) {
  $sessionId = Split-Path -Parent $log.FullName | Split-Path -Leaf
  $p = Join-Path $DshHome ("storages/session_projcache/sessions/$sessionId.json")
  if (Test-Path -LiteralPath $p) { $proj = $p }
  if (Test-Path -LiteralPath $metrics) {
    $raw = & node $metrics $log.FullName $(if ($proj) { $proj })
    if ($LASTEXITCODE -eq 0) { try { $mj = $raw | ConvertFrom-Json } catch { $mj = $null } }
  }
}

# ---- 1. Agent Loop ----------------------------------------------------------
if (-not $log) { Add-Result 'AgentLoop' $false 'no session log under <DSH_HOME>/sessions' }
elseif (-not $mj) { Add-Result 'AgentLoop' $false 'session-metrics.cjs produced no JSON' }
else { Add-Result 'AgentLoop' (($mj.loop.turns -ge 1) -and ($mj.loop.steps -ge 1)) ("session=" + $sessionId + " preset=" + $mj.preset + " turns=" + $mj.loop.turns + " steps=" + $mj.loop.steps) }

# ---- 2. Tool Calling --------------------------------------------------------
if (-not $mj) { Add-Result 'ToolCalling' $false 'no metrics' }
else { Add-Result 'ToolCalling' (($mj.loop.toolCalls -ge 1) -and ($mj.loop.toolResults -ge 1)) ("tool/call=" + $mj.loop.toolCalls + " tool/result=" + $mj.loop.toolResults + " ptc-dispatch=" + $mj.loop.ptcDispatches + " modelSideSchemas=" + $mj.tools.count) }

# ---- 3. Plugin Loading ------------------------------------------------------
$rows = 0; $resolved = 0; $unresolved = New-Object System.Collections.ArrayList
$roots = @(
  (Join-Path $DshHome 'profiles/desktop/node_modules'),
  (Join-Path $DshHome 'profiles/node_modules'),
  (Join-Path $AppRoot 'node_modules')
)
function Resolve-Package([string]$name) {
  $pkg = $name
  if ($pkg.StartsWith('@')) { $parts = $pkg.Split('/'); if ($parts.Count -lt 2) { return $null }; $pkg = $parts[0] + '/' + $parts[1] }
  else { $pkg = $pkg.Split('/')[0] }
  foreach ($r in $roots) { $c = Join-Path $r ($pkg -replace '/', '\'); if (Test-Path -LiteralPath $c) { return $c } }
  return $null
}
$yml = @()
foreach ($n in @('cordis.yml','cordis.patch.yml')) { $f = Join-Path $DshHome "profiles/desktop/$n"; if (Test-Path -LiteralPath $f) { $yml += Get-Content -LiteralPath $f -Encoding UTF8 } }
foreach ($line in $yml) {
  if ($line -match "^\s*name:\s*'?([^'\s]+)'?\s*$") {
    $name = $Matches[1]
    if ($name -like 'cordis:*' -or $name -like './*' -or $name -like '/*') { continue }
    $rows++
    if (Resolve-Package $name) { $resolved++ } else { [void]$unresolved.Add($name) }
  }
}
$lockOk = $false
$lockPath = Join-Path $DshHome 'profiles/desktop/desktop-plugins.lock.json'
if (Test-Path -LiteralPath $lockPath) { try { $null = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json; $lockOk = $true } catch {} }
$unres = $(if ($unresolved.Count -gt 0) { " unresolved=" + ($unresolved -join ',') } else { '' })
Add-Result 'PluginLoading' (($rows -gt 0) -and ($resolved -eq $rows) -and $lockOk) ("compositionRows=" + $rows + " resolved=" + $resolved + $unres + " lockParses=" + $lockOk)

# ---- 4. Session -------------------------------------------------------------
$b = $null
if ($proj) { try { $b = (Get-Content -LiteralPath $proj -Raw -Encoding UTF8 | ConvertFrom-Json).record.rows.contextBreakdown.val.breakdown } catch {} }
if ($b) { Add-Result 'Session' $true ("session=" + $sessionId + " systemTokens=" + $b.systemTokens + " toolsTokens=" + $b.toolsTokens + " messageTokens=" + $b.messageTokens) }
else { Add-Result 'Session' $false 'no contextBreakdown for the newest session' }

Write-Host ''
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
# ---- 5. RuntimeIntegrity: installed runtime files must match known-good hashes ----
# This is the P0 gate for the failure mode the audit found: hand-patching a file inside the
# installed runtime leaves no trace and is silently overwritten by the next upgrade.
$rtIssues = New-Object System.Collections.ArrayList
$kgPath = Join-Path $ResourcesRoot 'runtime-support/known-good.json'
$rtRoot = Join-Path $DshHome 'profiles/node_modules/@deepseek-ai/dsh'
if (-not (Test-Path -LiteralPath $kgPath)) { Add-Result 'RuntimeIntegrity' $false "known-good.json not found at $kgPath" }
elseif (-not (Test-Path -LiteralPath $rtRoot)) { Add-Result 'RuntimeIntegrity' $false "runtime not found at $rtRoot" }
else {
  $kg = Get-Content -LiteralPath $kgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $checked = 0
  foreach ($p in $kg.runtime.files.PSObject.Properties) {
    $f = Join-Path $rtRoot ($p.Name -replace '/', '\')
    if (-not (Test-Path -LiteralPath $f)) { [void]$rtIssues.Add("missing " + $p.Name); continue }
    $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
    $want = ([string]$p.Value).ToLower()
    if ($h -ne $want) { [void]$rtIssues.Add("drift " + $p.Name) }
    $checked++
  }
  $liveVer = 'unknown'
  $livePkg = Join-Path $rtRoot 'package.json'
  if (Test-Path -LiteralPath $livePkg) { try { $liveVer = (Get-Content -LiteralPath $livePkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {} }
  if ($liveVer -ne $kg.runtime.version) { [void]$rtIssues.Add("version " + $liveVer + " != known-good " + $kg.runtime.version) }
  Add-Result 'RuntimeIntegrity' ($rtIssues.Count -eq 0) $(if ($rtIssues.Count -eq 0) { "runtime " + $liveVer + " matches known-good ($checked files)" } else { $rtIssues -join '; ' })
}

# ---- 6. SnapshotIntegrity: the newest baseline snapshot must still verify ----
$bkRoot = Join-Path (Split-Path -Parent $scriptDir) 'backups'
$snaps = @(Get-ChildItem -LiteralPath $bkRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'pre-restore-*' } | Sort-Object Name -Descending)
if ($snaps.Count -eq 0) { Add-Result 'SnapshotIntegrity' $false "no snapshot under $bkRoot" }
else {
  $s = $snaps[0]
  $mp = Join-Path $s.FullName 'manifest.json'
  $bad = 0
  if (-not (Test-Path -LiteralPath $mp)) { Add-Result 'SnapshotIntegrity' $false "manifest.json missing in $($s.Name)" }
  else {
    $meta = Get-Content -LiteralPath $mp -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($m in $meta.files) {
      $f = Join-Path $s.FullName ($m.rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $f)) { $bad++; continue }
      if ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -ne $m.sha256) { $bad++ }
    }
    # drift is informational, not a gate: after a deliberate config change the live files SHOULD differ
    $drift = 0
    foreach ($m in $meta.files) { if (Test-Path -LiteralPath $m.src) { if ((Get-FileHash -LiteralPath $m.src -Algorithm SHA256).Hash -ne $m.sha256) { $drift++ } } }
    # Files ADDED under a snapshotted tree since the baseline are drift too - the manifest
    # can only see what existed when it was written. This is what catches an install.
    $treeRel = 'config/.agent-presets/'
    $treeSrc = Join-Path $DshHome '.agent-presets'
    $inManifest = @{}
    foreach ($m in $meta.files) { if ($m.rel.StartsWith($treeRel)) { $inManifest[$m.rel.Substring($treeRel.Length)] = $true } }
    $added = 0
    foreach ($f in (Get-ChildItem -LiteralPath $treeSrc -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $rel = $f.FullName.Substring($treeSrc.Length + 1).Replace('\', '/')
      if (-not $inManifest.ContainsKey($rel)) { $added++ }
    }
    Add-Result 'SnapshotIntegrity' ($bad -eq 0) ("baseline=" + $s.Name + " files=" + @($meta.files).Count + " corrupt=" + $bad + " liveDrift=" + $drift + " addedUnderAgentPresets=" + $added)
  }
}

$expected = 6
$failed = @($results | Where-Object { $_.Result -ne 'PASS' }).Count
if ($results.Count -ne $expected) {
  Write-Host ("FAIL: expected $expected checks, collected $($results.Count) - a check did not run")
  $failed += ($expected - $results.Count)
}
Write-Host ("CHECKS=" + (($results | ForEach-Object { $_.Check + ':' + $_.Result }) -join ','))
Write-Host ("RESULT: " + $(if ($failed -eq 0) { "OK ($($results.Count)/$expected)" } else { "FAIL ($failed of $expected)" }))
if ($failed -gt 0) { exit 1 }
exit 0
