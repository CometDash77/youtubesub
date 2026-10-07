# step-by-step launch diagnosis (mirrors run-verification.ps1 Start-Capcheck)
$ErrorActionPreference = "Continue"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host "T1 env cleaned; ELECTRON_RUN_AS_NODE=[$env:ELECTRON_RUN_AS_NODE]"
$env:CAPCHECK_SCENE = "base"
$root = $PSScriptRoot
Write-Host "T2 root=$root"
$exe = Join-Path $root "node_modules\electron\dist\electron.exe"
Write-Host "T3 exe exists=$(Test-Path $exe)"
Write-Host "T3b mirror var ELECTRON_MIRROR=[$env:ELECTRON_MIRROR]"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
cmd /c ('start "capcheck" /D "' + $root + '" "' + $exe + '" "' + $root + '"')
Write-Host ("T4 start returned in " + $sw.ElapsedMilliseconds + "ms")
Start-Sleep -Seconds 5
$procs = @(Get-Process electron -ErrorAction SilentlyContinue)
Write-Host "T5 procs=$($procs.Count)"
$procs | ForEach-Object { Write-Host "  pid=$($_.Id) title=[$($_.MainWindowTitle)]" }
Write-Host "T6 done"
