[CmdletBinding()]
param(
  [string]$DshHome    = (Join-Path $env:USERPROFILE '.dsh-community'),
  [string]$SkillsHome = (Join-Path $env:USERPROFILE '.agents\skills'),
  [string]$SnapshotRoot,
  [string]$Label = 'manual'
)
$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Resolve-Path (Join-Path (Get-Location) 'harness/scripts')).Path }
if (-not $SnapshotRoot) { $SnapshotRoot = Join-Path (Split-Path -Parent $scriptDir) 'backups' }

$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $SnapshotRoot ("$ts-$Label")
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$manifest        = New-Object System.Collections.ArrayList
$missingRequired = New-Object System.Collections.ArrayList
$missingOptional = New-Object System.Collections.ArrayList

function Add-SnapFile([string]$src, [string]$rel, [switch]$Required) {
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
    if ($Required) { [void]$missingRequired.Add($src) } else { [void]$missingOptional.Add($src) }
    return
  }
  $d = Join-Path $dest ($rel -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null
  Copy-Item -LiteralPath $src -Destination $d -Force
  $item = Get-Item -LiteralPath $d
  [void]$manifest.Add([pscustomobject]@{
    rel    = $rel
    src    = (Resolve-Path -LiteralPath $src).Path
    bytes  = $item.Length
    sha256 = (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash
  })
}
function Add-SnapTree([string]$srcRoot, [string]$relRoot, [switch]$Required) {
  if (-not (Test-Path -LiteralPath $srcRoot -PathType Container)) {
    if ($Required) { [void]$missingRequired.Add($srcRoot) } else { [void]$missingOptional.Add($srcRoot) }
    return
  }
  foreach ($f in (Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force)) {
    $rel = $relRoot + '/' + $f.FullName.Substring($srcRoot.Length + 1).Replace('\', '/')
    Add-SnapFile $f.FullName $rel
  }
}

# Required: the config that actually decides agent behaviour.
Add-SnapFile (Join-Path $DshHome 'settings.yaml') 'config/settings.yaml' -Required
Add-SnapTree (Join-Path $DshHome '.agent-presets') 'config/.agent-presets' -Required
# Optional: profile composition. Missing here means a leaner install, not a broken snapshot.
foreach ($n in @('cordis.yml','cordis.patch.yml','package.json','desktop-plugins.lock.json','pnpm-workspace.yaml')) {
  Add-SnapFile (Join-Path $DshHome "profiles/desktop/$n") "profile/$n"
}
Add-SnapTree $SkillsHome 'skills'

$app = 'unknown'; $runtime = 'unknown'
$kg = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\runtime-support\known-good.json'
if (Test-Path -LiteralPath $kg) {
  try { $k = Get-Content -LiteralPath $kg -Raw -Encoding UTF8 | ConvertFrom-Json; $app = $k.desktop.version; $runtime = $k.runtime.version } catch {}
}

$total = 0; foreach ($m in $manifest) { $total += $m.bytes }
$meta = [pscustomobject]@{
  createdAt      = (Get-Date).ToString('o')
  label          = $Label
  host           = $env:COMPUTERNAME
  dshHome        = $DshHome
  skillsHome     = $SkillsHome
  desktopVersion = $app
  runtimeVersion = $runtime
  fileCount      = $manifest.Count
  totalBytes     = $total
  missingRequired = @($missingRequired)
  missingOptional = @($missingOptional)
  files          = @($manifest)
}
$manifestPath = Join-Path $dest 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, ($meta | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

# self-check: re-hash every snapshot file and compare with the manifest
$bad = 0
foreach ($m in $manifest) {
  $d = Join-Path $dest ($m.rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $d)) { Write-Host "FAIL missing in snapshot: $($m.rel)"; $bad++; continue }
  $h = (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash
  if ($h -ne $m.sha256) { Write-Host "FAIL hash mismatch: $($m.rel)"; $bad++ }
}

Write-Host "snapshot : $dest"
Write-Host "files    : $($manifest.Count) ($([math]::Round($total/1KB,1)) KB)"
Write-Host "app/runtime: $app / $runtime"
if ($missingOptional.Count -gt 0) { Write-Host "warn: optional sources absent:"; $missingOptional | ForEach-Object { Write-Host "  $_" } }
if ($missingRequired.Count -gt 0) { Write-Host "MISSING REQUIRED SOURCES:"; $missingRequired | ForEach-Object { Write-Host "  $_" } }
if ($bad -gt 0 -or $missingRequired.Count -gt 0) { Write-Host "RESULT: FAIL"; exit 1 }
Write-Host "RESULT: OK"
exit 0
