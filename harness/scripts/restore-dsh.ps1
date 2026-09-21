[CmdletBinding()]
param(
  [string]$Snapshot,
  [string]$DshHome    = (Join-Path $env:USERPROFILE '.dsh-community'),
  [string]$SkillsHome = (Join-Path $env:USERPROFILE '.agents\skills'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Resolve-Path (Join-Path (Get-Location) 'harness/scripts')).Path }
$backupRoot = Join-Path (Split-Path -Parent $scriptDir) 'backups'
if (-not $Snapshot) {
  $Snapshot = (Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1).FullName
  if (-not $Snapshot) { Write-Host 'no snapshot found; pass -Snapshot <dir>'; exit 2 }
}
$manifestPath = Join-Path $Snapshot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Host "manifest.json not found in $Snapshot"; exit 2 }
$meta = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Target-Of([string]$rel) {
  if ($rel -like 'config/*')  { return (Join-Path $DshHome   $rel.Substring(7).Replace('/', '\')) }
  if ($rel -like 'profile/*') { return (Join-Path $DshHome   ('profiles\desktop\' + $rel.Substring(8).Replace('/', '\'))) }
  if ($rel -like 'skills/*')  { return (Join-Path $SkillsHome $rel.Substring(7).Replace('/', '\')) }
  throw "unmapped rel: $rel"
}

$plan = @()
foreach ($m in $meta.files) { $plan += [pscustomobject]@{ m = $m; snap = (Join-Path $Snapshot ($m.rel -replace '/', '\')); target = (Target-Of $m.rel) } }

# integrity of the snapshot itself, before touching anything
$bad = 0
foreach ($p in $plan) {
  if (-not (Test-Path -LiteralPath $p.snap)) { Write-Host "FAIL snapshot file missing: $($p.m.rel)"; $bad++; continue }
  if ((Get-FileHash -LiteralPath $p.snap -Algorithm SHA256).Hash -ne $p.m.sha256) { Write-Host "FAIL snapshot hash: $($p.m.rel)"; $bad++ }
}
if ($bad -gt 0) { Write-Host 'RESULT: FAIL (snapshot corrupt, nothing restored)'; exit 1 }

# pre-restore safety copy of whatever we are about to overwrite
$pre = Join-Path $Snapshot ("pre-restore-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (-not $DryRun) {
  foreach ($p in $plan) {
    if (Test-Path -LiteralPath $p.target) {
      $d = Join-Path $pre ($p.m.rel -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null
      Copy-Item -LiteralPath $p.target -Destination $d -Force
    }
  }
}

$restored = 0; $failed = 0
foreach ($p in $plan) {
  if ($DryRun) { Write-Host ("would restore {0} -> {1}" -f $p.m.rel, $p.target); continue }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p.target) | Out-Null
  Copy-Item -LiteralPath $p.snap -Destination $p.target -Force
  if (-not (Test-Path -LiteralPath $p.target)) { Write-Host "FAIL not written: $($p.m.rel)"; $failed++; continue }
  if ((Get-FileHash -LiteralPath $p.target -Algorithm SHA256).Hash -ne $p.m.sha256) { Write-Host "FAIL hash after restore: $($p.m.rel)"; $failed++; continue }
  $restored++
}
Write-Host "snapshot : $Snapshot"
Write-Host "restored : $restored / $($plan.Count)"
if (-not $DryRun) { Write-Host "pre-restore safety copy: $pre" }
if ($failed -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 }
Write-Host 'RESULT: OK'
exit 0
