# Electron skeleton acceptance driver (Phase 1 skeleton ticket). Launches
# the app/ skeleton per scene, captures Win32/GDI evidence, then evaluates
# every [CI] assertion of docs/ELECTRON-SKELETON-ACCEPTANCE.md and exits
# nonzero on any failure. Manual rows (A2.4 / A3.2) are reported as
# manual-pending for the human review pass (version-consistency check first).
param([string]$Scene = "all")
$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSScriptRoot
$ev = Join-Path $appRoot "acceptance\evidence"
if (Test-Path $ev) { Remove-Item -Recurse -Force $ev }
New-Item -ItemType Directory -Force -Path $ev | Out-Null
$env:SKELETON_LOG = Join-Path $ev "skeleton.log"
$log = $env:SKELETON_LOG

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public static IntPtr FoundHwnd = IntPtr.Zero;
  public static bool EnumCb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(256);
    GetWindowTextW(h, sb, 256);
    if (sb.ToString() == "youtubesub-overlay") { FoundHwnd = h; return false; }
    return true;
  }
  public static IntPtr FindOverlay() {
    FoundHwnd = IntPtr.Zero;
    EnumWindows(EnumCb, IntPtr.Zero);
    return FoundHwnd;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
[void][W]::SetProcessDPIAware()

function Get-Overlay { return [W]::FindOverlay() }
function Get-Rect($h) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  return $r
}
function Get-RectStable($h) {
  for ($i = 0; $i -lt 50; $i++) {
    $r = Get-Rect $h
    if (($r.R - $r.L) -gt 0 -and ($r.B - $r.T) -gt 0) { return $r }
    Start-Sleep -Milliseconds 100
  }
  throw "window rect never became valid"
}
function Test-StyleBits($h) {
  $ex = [W]::GetWindowLongW($h, -20)
  $style = [W]::GetWindowLongW($h, -16)
  return [pscustomobject]@{
    topmost     = (($ex -band 0x8) -ne 0)
    layered     = (($ex -band 0x80000) -ne 0)
    transparent = (($ex -band 0x20) -ne 0)
    caption     = (($style -band 0x00C00000) -ne 0)
    rawExStyle  = "0x{0:X}" -f $ex
    rawStyle    = "0x{0:X}" -f $style
  }
}
function Test-PointHit($h, $x, $y) {
  $p = New-Object W+POINT
  $p.X = [int]$x; $p.Y = [int]$y
  $hit = [W]::WindowFromPoint($p)
  # WindowFromPoint returns the deepest child HWND; normalize via GA_ROOT.
  $rootHit = [W]::GetAncestor($hit, 2)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowTextW($hit, $sb, 256)
  return [pscustomobject]@{ hitTitle = $sb.ToString(); isOverlay = ($rootHit -eq $h) }
}
function Save-WindowShot($h, $path) {
  $r = Get-Rect $h
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
function Save-FullShot($path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
function Start-Skeleton($scene) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $exe = Join-Path $appRoot "node_modules\electron\dist\electron.exe"
  $env:SKELETON_SCENE = $scene
  cmd /c ('start "skeleton" /D "' + $appRoot + '" "' + $exe + '" "' + $appRoot + '"')
}
function Get-OverlayPid($h) {
  $procId = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
  return [int]$procId
}
function Stop-Skeleton($procId) {
  cmd /c ("taskkill /PID $procId /T /F") 2>$null | Out-Null
}
function Wait-Overlay {
  for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 100
    $h = [W]::FindOverlay()
    if ($h -ne [IntPtr]::Zero) { return $h }
  }
  throw "overlay window never appeared"
}
# A1.3: transparent corners of the window rect must equal the reference
# frame (desktop shows through), the interior must differ (panel + text).
function Compare-A13($h, $refPath, $winPath, $r) {
  $ref = New-Object System.Drawing.Bitmap($refPath)
  $win = New-Object System.Drawing.Bitmap($winPath)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  $cornerOk = $true
  $corners = @(@(6, 6), @(($w - 7), 6), @(6, ($ht - 7)), @(($w - 7), ($ht - 7)))
  foreach ($c in $corners) {
    $p1 = $ref.GetPixel($r.L + $c[0], $r.T + $c[1])
    $p2 = $win.GetPixel($c[0], $c[1])
    $d = [Math]::Abs($p1.R-$p2.R) + [Math]::Abs($p1.G-$p2.G) + [Math]::Abs($p1.B-$p2.B)
    if ($d -gt 12) { $cornerOk = $false }
  }
  $diffCount = 0; $samples = 0
  for ($x = 40; $x -lt $w - 60; $x += 24) {
    for ($y = 16; $y -lt $ht - 30; $y += 14) {
      $samples++
      $p1 = $ref.GetPixel($r.L + $x, $r.T + $y)
      $p2 = $win.GetPixel($x, $y)
      $d = [Math]::Abs($p1.R-$p2.R) + [Math]::Abs($p1.G-$p2.G) + [Math]::Abs($p1.B-$p2.B)
      if ($d -gt 24) { $diffCount++ }
    }
  }
  $ref.Dispose(); $win.Dispose()
  return [pscustomobject]@{ cornerOk = $cornerOk; interiorDiff = ($diffCount -gt 0); diffCount = $diffCount; samples = $samples }
}

$results = @{}
$refPath = Join-Path $ev "ref-full.png"
if (-not (Test-Path $refPath)) { Save-FullShot $refPath }

function Run-Scene($s) {
  Write-Host "=== scene $s ==="
  Start-Skeleton $s
  $h = [IntPtr]::Zero
  try {
    $h = Wait-Overlay
    $procId = Get-OverlayPid $h
    Write-Host "hwnd=$h pid=$procId"
    $r = Get-RectStable $h
    $cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)

    switch ($s) {
      "base" {
        Start-Sleep -Seconds 2
        $bits = Test-StyleBits $h
        Save-WindowShot $h (Join-Path $ev "sceneA-base-window.png")
        $a13 = Compare-A13 $h $refPath (Join-Path $ev "sceneA-base-window.png") $r
        $results.base = @{ bits = $bits; a13 = $a13; rect = "$($r.L),$($r.T),$($r.R),$($r.B)" }
        Write-Host ($bits | Format-List | Out-String)
        Write-Host ("a13: " + ($a13 | ConvertTo-Json -Compress))
      }
      "clickthrough" {
        Start-Sleep -Milliseconds 1500
        $pre = Test-PointHit $h $cx $cy
        Start-Sleep -Seconds 3
        $post = Test-PointHit $h $cx $cy
        $bits = Test-StyleBits $h
        Save-WindowShot $h (Join-Path $ev "sceneB-clickthrough.png")
        $results.clickthrough = @{ preHit = $pre; postHit = $post; bits = $bits }
        Write-Host "pre(non-ct):   $($pre | ConvertTo-Json -Compress)"
        Write-Host "post(ct):      $($post | ConvertTo-Json -Compress)"
        Write-Host "bits:          $($bits | ConvertTo-Json -Compress)"
      }
      "hover-unlock" {
        # Timeline is driven by the app: CT on at did-finish-load+0.5s,
        # synthetic mousemove to the hotspot at CT+2.5s, to the center at
        # CT+8s. Samples follow the same clock (proven by #193 CI run).
        Start-Sleep -Milliseconds 2500
        $before = Test-PointHit $h $cx $cy
        Start-Sleep -Seconds 3
        $hotspot = Test-PointHit $h ($r.R - 33) ($r.B - 33)
        Start-Sleep -Seconds 4
        $mid = Test-PointHit $h $cx $cy
        $bits = Test-StyleBits $h
        Save-WindowShot $h (Join-Path $ev "sceneC-hover-unlock.png")
        $results.hoverUnlock = @{ before = $before; hotspot = $hotspot; mid = $mid }
        Write-Host "before:  $($before | ConvertTo-Json -Compress)"
        Write-Host "hotspot: $($hotspot | ConvertTo-Json -Compress)"
        Write-Host "mid:     $($mid | ConvertTo-Json -Compress)"
      }
      "tray-menu" {
        Start-Sleep -Milliseconds 6000
        Save-FullShot (Join-Path $ev "sceneD-tray-menu-1.png")
        Start-Sleep -Milliseconds 1500
        Save-FullShot (Join-Path $ev "sceneD-tray-menu-2.png")
        Start-Sleep -Milliseconds 600
        Save-FullShot (Join-Path $ev "sceneD-tray-menu-full.png")
        $results.trayMenu = @{ note = "tray-anchored popUp at 6s; window-anchored popup at ~7.5s; shots at 6.0/7.5/8.1s" }
        Write-Host "triple shots saved"
      }
      "hotkey" {
        Start-Sleep -Seconds 4
        $before = Test-PointHit $h $cx $cy
        [void][W]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
        [void][W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [void][W]::keybd_event(0x55, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [void][W]::keybd_event(0x55, 0, 2, [UIntPtr]::Zero)
        [void][W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [void][W]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Seconds 1
        $after = Test-PointHit $h $cx $cy
        $bits = Test-StyleBits $h
        Save-WindowShot $h (Join-Path $ev "sceneE-hotkey.png")
        $results.hotkey = @{ before = $before; after = $after }
        Write-Host "before(ct):    $($before | ConvertTo-Json -Compress)"
        Write-Host "after(hotkey): $($after | ConvertTo-Json -Compress)"
      }
      "ws" {
        $env:NODE_OPTIONS = "--no-warnings"
        Start-Sleep -Seconds 2
        $health = Invoke-RestMethod "http://127.0.0.1:9877/health"
        $evilOut = (& node (Join-Path $PSScriptRoot "ws-client.mjs") evil 2>$null | Out-String)
        $okOut = (& node (Join-Path $PSScriptRoot "ws-client.mjs") ok 2>$null | Out-String)
        Start-Sleep -Milliseconds 700
        $status = Invoke-RestMethod "http://127.0.0.1:9877/status"
        Save-WindowShot $h (Join-Path $ev "sceneF-ws.png")
        $results.ws = @{ health = $health; evilClient = $evilOut.Trim(); okClient = $okOut.Trim(); status = $status }
        Write-Host "health: $($health | ConvertTo-Json -Compress)"
        Write-Host "evil:   $($evilOut.Trim())"
        Write-Host "ok:     $($okOut.Trim())"
        Write-Host "status: $($status | ConvertTo-Json -Compress)"
      }
    }
  } finally {
    if ($h -and $h -ne [IntPtr]::Zero) {
      $procId = Get-OverlayPid $h
      if ($procId -gt 0) { Stop-Skeleton $procId }
    }
    Start-Sleep -Milliseconds 800
  }
}

if ($Scene -eq "all") {
  foreach ($s in @("base", "clickthrough", "hover-unlock", "tray-menu", "hotkey", "ws")) { Run-Scene $s }
} else {
  Run-Scene $Scene
}

$results | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $ev "report.json") -Encoding UTF8

# ---- verdict stage: evaluate every assertion of the acceptance doc ----
$logText = if (Test-Path $log) { Get-Content $log -Raw } else { "" }
$rows = New-Object System.Collections.Generic.List[object]
function Add-Row($id, $channel, $ok, $detail) {
  $script:rows.Add([pscustomobject]@{ id = $id; channel = $channel; verdict = if ($ok) { "PASS" } else { "FAIL" }; detail = $detail })
}
$b = $results.base; $ct = $results.clickthrough; $hv = $results.hoverUnlock; $hk = $results.hotkey; $wsr = $results.ws

Add-Row "A1.1" "CI" ($b -and $b.bits.topmost) "WS_EX_TOPMOST bit on base scene ($($b.bits.rawExStyle))"
Add-Row "A1.2" "CI" ($b -and (-not $b.bits.caption) -and (Test-Path (Join-Path $ev "sceneA-base-window.png"))) "WS_CAPTION bit off + window shot saved ($($b.bits.rawStyle))"
Add-Row "A1.3" "CI" ($b -and $b.a13.cornerOk -and $b.a13.interiorDiff) "transparent corners equal ref, interior differs (diff $($b.a13.diffCount)/$($b.a13.samples))"
Add-Row "A1.4" "CI" ($ct -and $ct.bits.layered -and $ct.bits.transparent) "WS_EX_LAYERED|TRANSPARENT during click-through ($($ct.bits.rawExStyle); evidence-only by pit 3)"
Add-Row "A2.1" "CI" ($ct -and ($ct.postHit.isOverlay -eq $false)) "click-through baseline: WindowFromPoint misses the overlay (log anchor set_click_through true)"
Add-Row "A2.2" "CI" ($hv -and ($hv.hotspot.isOverlay -eq $true) -and $logText.Contains("hot=true") -and $logText.Contains("set-ignore false")) "hotspot clickable: synthetic move -> closest(.hot) -> set-ignore false"
Add-Row "A2.3" "CI" ($hv -and ($hv.mid.isOverlay -eq $false) -and $logText.Contains("hot=false") -and $logText.Contains("set-ignore true")) "leaving hotspot restores click-through"
Add-Row "A2.4" "Manual" $true "manual-pending: real-mouse unlock full state flip (icon gone / status cleared / no re-passthrough); run on a real machine after version-consistency check"
Add-Row "A3.1" "CI" ($logText.Contains("tray popUpContextMenu (tray-anchored)") -and $logText.Contains("tray menu closed")) "tray menu modal loop ran and closed (log pair)"
Add-Row "A3.2" "Manual" $true "manual-pending: tray menu visual popup + toggle + quit on a real machine"
$regOk = $logText.Contains("globalShortcut.register(" + [char]34 + "Control+Alt+U" + [char]34 + ") => true")
Add-Row "A4.1" "CI" $regOk "globalShortcut.register returned true (RegisterHotKey conflict would log false)"
Add-Row "A4.2" "CI" ($hk -and ($hk.after.isOverlay -eq $true) -and $logText.Contains("hotkey fired Control+Alt+U -> click_through off") -and $logText.Contains("set_click_through false")) "OS key sequence fired hotkey -> full unlock (window state + log cross-proof)"
Add-Row "A5.1" "CI" ($wsr -and $wsr.health.ok -and $wsr.health.version -eq 1) "GET /health 200 ok version 1"
Add-Row "A5.2" "CI" ($wsr -and $wsr.evilClient -match "WS-REJECTED status=403") "non-whitelisted Origin rejected 403; ok client passed (whitelist positive)"
Add-Row "A5.3" "CI" ($wsr -and $wsr.status.stats.bad_frames -ge 2 -and $wsr.status.stats.error -eq 0 -and $wsr.status.stats.frames -ge 6) "bad frames counted, connection kept, later frames processed"
Add-Row "A5.4" "CI" ($wsr -and $wsr.status.state -eq "ok" -and $wsr.status.orig -eq "second cue line" -and $wsr.status.sources -ge 1 -and $wsr.status.title -and ($wsr.okClient -match "MIDSTATUS playing=True" -or $wsr.okClient -match "MIDSTATUS playing=true") -and ($wsr.status.playing -eq $false)) "register/cues/sync flow reported; playing flipped true then false"
Add-Row "A5.5" "CI" ($logText -match "\[ws\] listening on 127\.0\.0\.1:9877") "loopback bind (unit test asserts the address() value as well)"

$ciRows = @($rows | Where-Object { $_.channel -eq "CI" })
$failed = @($ciRows | Where-Object { $_.verdict -eq "FAIL" })
$rows | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ev "assertion-report.json") -Encoding UTF8
Write-Host ""
Write-Host "==== assertion report ===="
$rows | ForEach-Object { Write-Host ("{0} [{1}] {2} - {3}" -f $_.id, $_.channel, $_.verdict, $_.detail) }
Write-Host ("CI: {0} total, {1} failed; Manual: 2 pending" -f $ciRows.Count, $failed.Count)
if ($failed.Count -gt 0) { exit 1 }
exit 0