<#
.SYNOPSIS
  Get the DSH desktop app out of its throwaway 'safe' profile so installed
  plugins stop disappearing after a restart.

.DESCRIPTION
  Symptom: plugins installed in the desktop app are gone after a restart.
  Cause: when the app's active profile is 'safe' (its safe-mode profile), the
  launch flow deletes every user plugin from that profile:
    main::service::plugin::safe: safe mode: removing N user plugin(s) from the safe profile
  This script renames profiles/safe (default: profiles/main) and points
  .store.dat's active_profile at the new name, keeping the profile content
  (cordis.patch.yml, node_modules, installed plugins) exactly as it is.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File harness/scripts/fix-dsh-safe-mode.ps1
  # after fully quitting the desktop app:
  powershell -ExecutionPolicy Bypass -File harness/scripts/fix-dsh-safe-mode.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string]$NewProfileName = 'main',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'

$DshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$Profiles = Join-Path $DshHome 'profiles'
$Store    = Join-Path $env:APPDATA 'dsh-tauri/.store.dat'
$AppLog   = Join-Path $env:APPDATA 'dsh-tauri/logs/desktop.log'

function Get-ActiveProfile {
  if (-not (Test-Path -LiteralPath $Store)) { return $null }
  (Get-Content -LiteralPath $Store -Raw | ConvertFrom-Json).setting.active_profile
}

function Get-DanglingLinks {
  Get-ChildItem (Join-Path $Profiles '*\node_modules') -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LinkType -and $_.Target -and -not (Test-Path -LiteralPath $_.Target) }
}

Write-Host "DSH_HOME      : $DshHome"
$active = Get-ActiveProfile
Write-Host "active_profile: $active"

$dangling = @(Get-DanglingLinks)
Write-Host "dangling links: $($dangling.Count)"
$dangling | ForEach-Object { Write-Host "  $($_.FullName) -> $($_.Target)" }

if (Test-Path -LiteralPath $AppLog) {
  $purges = Select-String -LiteralPath $AppLog -Pattern 'safe mode: removing|SAFE_MODE_PLUGIN_PURGE: removed' | Select-Object -Last 4
  if ($purges) {
    Write-Host ''
    Write-Host 'last plugin purges by the app:'
    $purges | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
  }
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '-- verdict --'
  if ($active -eq 'safe') {
    Write-Host 'RED  : active_profile is safe - every app launch wipes user plugins in it.'
  } else {
    Write-Host 'GREEN: active_profile is not safe - the safe-mode purge will not run.'
  }
  if ($dangling.Count -gt 0) { Write-Host 'WARN : dangling directory links remain; pnpm fails on them (os error 448) and can push the app back into safe mode.' }
  $bin = Join-Path (Split-Path -Parent $DshHome) 'dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
  if (Test-Path -LiteralPath $bin) {
    $prof = if ($active) { $active } else { 'safe' }
    Write-Host ''
    Write-Host "-- composing profile '$prof' (dsh --dump-config) --"
    & node $bin --profile $prof --dump-config 2>&1 | Select-String -Pattern 'skipping profile bundle|patch: entry|cannot resolve' | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
  }
  return
}

if (Get-Process -Name 'deepseek-harness-desktop' -ErrorAction SilentlyContinue) {
  throw 'The desktop app is still running. Quit Deepseek Harness Desktop from the tray first, then re-run with -Apply.'
}
if ($active -ne 'safe') { Write-Host "active_profile is already '$active'; nothing to rename."; return }
$src = Join-Path $Profiles 'safe'
$dst = Join-Path $Profiles $NewProfileName
if (-not (Test-Path -LiteralPath $src)) { throw "profile directory not found: $src" }
if (Test-Path -LiteralPath $dst) { throw "target profile already exists: $dst" }

Rename-Item -LiteralPath $src -NewName $NewProfileName
$manifest = Join-Path $dst 'package.json'
if (Test-Path -LiteralPath $manifest) {
  $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  if ($json.PSObject.Properties.Name -contains 'name') { $json.name = "dsh-profile-$NewProfileName" }
  ($json | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $manifest -Encoding UTF8
}

$raw = Get-Content -LiteralPath $Store -Raw
$new = $raw -replace '("active_profile"\s*:\s*)"safe"', ('$1"' + $NewProfileName + '"')
if ($new -eq $raw) { throw 'could not rewrite active_profile in .store.dat; check the file by hand.' }
Set-Content -LiteralPath $Store -Value $new -NoNewline -Encoding UTF8

Write-Host "renamed: profiles/safe -> profiles/$NewProfileName"
Write-Host "written: $Store active_profile = $NewProfileName"
Write-Host "next   : start Deepseek Harness Desktop, then confirm $AppLog shows no new 'safe mode: removing' line."
