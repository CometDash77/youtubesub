[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Resolve-Path (Join-Path (Get-Location) 'harness/scripts')).Path }
$backupScript  = Join-Path $scriptDir 'backup-dsh.ps1'
$restoreScript = Join-Path $scriptDir 'restore-dsh.ps1'
$exe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if (-not $exe) { $exe = 'powershell' }

$root = Join-Path $env:TEMP ('dsh-selftest-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$fxHome = Join-Path $root 'dsh-community'
$sk   = Join-Path $root 'skills'
$snap = Join-Path $root 'backups'
New-Item -ItemType Directory -Force -Path (Join-Path $fxHome '.agent-presets\demo'), (Join-Path $fxHome 'profiles\desktop'), (Join-Path $sk 'demo'), $snap | Out-Null

Set-Content -LiteralPath (Join-Path $fxHome 'settings.yaml') -Value "agent-presets:`n  default: ptc`n" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome '.agent-presets\demo\agent.cordis.yml') -Value "- id: demo`n  name: '@deepseek-ai/dsh-tools'`n" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome 'profiles\desktop\cordis.yml') -Value '[]' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome 'profiles\desktop\cordis.patch.yml') -Value '- id: demo' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome 'profiles\desktop\package.json') -Value '{ "name": "fx" }' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome 'profiles\desktop\desktop-plugins.lock.json') -Value '{ "plugins": [] }' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $fxHome 'profiles\desktop\pnpm-workspace.yaml') -Value 'packages: []' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $sk 'demo\SKILL.md') -Value "# demo skill`n" -Encoding UTF8

function Hash-Tree([string]$r) {
  $h = @{}
  foreach ($f in (Get-ChildItem -LiteralPath $r -Recurse -File -Force)) { $h[$f.FullName.Substring($r.Length)] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash }
  return $h
}
$before = Hash-Tree $fxHome
$beforeSk = Hash-Tree $sk

Write-Host '=== 1/3 backup (fixture) ==='
& $exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -DshHome $fxHome -SkillsHome $sk -SnapshotRoot $snap -Label selftest
if ($LASTEXITCODE -ne 0) { Write-Host "RESULT: FAIL (backup exit $LASTEXITCODE)"; exit 1 }
$snapDir = (Get-ChildItem -LiteralPath $snap -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName

Write-Host '=== 2/3 mutate the fixture ==='
Set-Content -LiteralPath (Join-Path $fxHome 'settings.yaml') -Value "agent-presets:`n  default: standard`n# mutated`n" -Encoding UTF8
Add-Content  -LiteralPath (Join-Path $fxHome '.agent-presets\demo\agent.cordis.yml') -Value "# mutated`n"
Remove-Item  -LiteralPath (Join-Path $sk 'demo\SKILL.md') -Force
$mutated = (Get-FileHash -LiteralPath (Join-Path $fxHome 'settings.yaml') -Algorithm SHA256).Hash -ne $before['\settings.yaml']
Write-Host ("fixture now differs from snapshot: " + $mutated)

Write-Host '=== 3/3 restore ==='
& $exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript -DshHome $fxHome -SkillsHome $sk -Snapshot $snapDir
if ($LASTEXITCODE -ne 0) { Write-Host "RESULT: FAIL (restore exit $LASTEXITCODE)"; exit 1 }

$after = Hash-Tree $fxHome
$afterSk = Hash-Tree $sk
$bad = 0
foreach ($k in $before.Keys)   { if ($after[$k]   -ne $before[$k])   { Write-Host "DIFF home$k";   $bad++ } }
foreach ($k in $beforeSk.Keys) { if ($afterSk[$k] -ne $beforeSk[$k]) { Write-Host "DIFF skills$k"; $bad++ } }
if ($bad -gt 0) { Write-Host "RESULT: FAIL ($bad files differ after restore)"; Write-Host "artifacts kept at $root"; exit 1 }

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("RESULT: OK - backup -> mutate -> restore round-trip byte-identical (" + $before.Count + " home + " + $beforeSk.Count + " skills files)")
exit 0
