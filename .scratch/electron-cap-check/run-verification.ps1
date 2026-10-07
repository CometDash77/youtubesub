# Electron five-capability evidence driver (per-scene capture -> evidence/)
param([string]$Scene = "all")
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$ev = Join-Path $root "evidence"
New-Item -ItemType Directory -Force -Path $ev | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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
    if (sb.ToString() == "capcheck-overlay") { FoundHwnd = h; return false; }
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

function Get-Overlay { return [W]::FindWindowW($null, "capcheck-overlay") }
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
  return [pscustomobject]@{
    topmost     = (($ex -band 0x8) -ne 0)
    layered     = (($ex -band 0x80000) -ne 0)
    transparent = (($ex -band 0x20) -ne 0)
    rawExStyle  = "0x{0:X}" -f $ex
  }
}
function Test-PointHit($h, $x, $y) {
  $p = New-Object W+POINT
  $p.X = [int]$x; $p.Y = [int]$y
  $hit = [W]::WindowFromPoint($p)
  # WindowFromPoint returns the deepest child HWND; Chromium windows nest
  # Chrome Legacy Window under the top-level frame. Normalize via GA_ROOT.
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
# launch via cmd start (Start-Process breaks on NO_PROXY/no_proxy env clash)
function Log($m) { Write-Host ("[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $m) }
function Start-Capcheck($scene) {
  Log "start-capcheck begin scene=$s scene-var=$scene"
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Log "env cleaned; run-as-node=[$env:ELECTRON_RUN_AS_NODE]"
  $exe = Join-Path $root "node_modules\electron\dist\electron.exe"
  $env:CAPCHECK_SCENE = $scene
  Log "issuing cmd start exe=$exe"
  cmd /c ('start "capcheck" /D "' + $root + '" "' + $exe + '" "' + $root + '"')
  Log "cmd start returned"
}
function Get-OverlayPid($h) {
  $procId = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
  return [int]$procId
}
function Stop-Capcheck($procId) {
  cmd /c ("taskkill /PID $procId /T /F") 2>$null | Out-Null
}
function Wait-Overlay {
  for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 100
    if ($i % 10 -eq 0) {
      $np = @(Get-Process electron -ErrorAction SilentlyContinue).Count
      Log ("wait-overlay iter=$i electronProcs=$np")
    }
    $h = [W]::FindOverlay()
    if ($h -ne [IntPtr]::Zero) { Log ("found hwnd=" + $h); return $h }
  }
  throw "overlay window never appeared"
}

$results = @{}

function Run-Scene($s) {
  Write-Host "=== scene $s ==="
  Start-Capcheck $s
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
        Save-FullShot (Join-Path $ev "sceneA-base-full.png")
        Save-WindowShot $h (Join-Path $ev "sceneA-base-window.png")
        $results.base = @{ bits = $bits; rect = "$($r.L),$($r.T),$($r.R),$($r.B)" }
        Write-Host ($bits | Format-List | Out-String)
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
        Start-Sleep -Seconds 4
        $before = Test-PointHit $h $cx $cy
        [void][W]::SetCursorPos($r.R - 33, $r.B - 33)
        Start-Sleep -Milliseconds 1200
        $hotspot = Test-PointHit $h ($r.R - 33) ($r.B - 33)
        # set-ignore is window-global; leaving the hotspot must make the
        # renderer restore click-through. Move back to center and re-probe.
        [void][W]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 1200
        $mid = Test-PointHit $h $cx $cy
        $bits = Test-StyleBits $h
        Save-WindowShot $h (Join-Path $ev "sceneC-hover-unlock.png")
        $results.hoverUnlock = @{ before = $before; hotspot = $hotspot; midStillCt = $mid }
        Write-Host "before:        $($before | ConvertTo-Json -Compress)"
        Write-Host "hotspot:       $($hotspot | ConvertTo-Json -Compress)"
        Write-Host "mid(still ct): $($mid | ConvertTo-Json -Compress)"
        Write-Host "bits:          $($bits | ConvertTo-Json -Compress)"
      }
      "tray-menu" {
        Start-Sleep -Milliseconds 6500
        Save-FullShot (Join-Path $ev "sceneD-tray-menu-full.png")
        $results.trayMenu = @{ note = "popUpContextMenu at 5s; full screenshot shows open menu" }
        Write-Host "full shot saved"
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
        Write-Host "bits:          $($bits | ConvertTo-Json -Compress)"
      }
      "ws" {
        # node 22 emits UNDICI stderr warnings; with 2>&1 under Stop preference
        # they abort the scene. Drop stderr, keep stdout verdicts.
        $env:NODE_OPTIONS = "--no-warnings"
        Start-Sleep -Seconds 2
        $health = Invoke-RestMethod "http://127.0.0.1:9877/health"
        $evilOut = (& node (Join-Path $root "ws-client.js") evil 2>$null | Out-String)
        $okOut = (& node (Join-Path $root "ws-client.js") ok 2>$null | Out-String)
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
      if ($procId -gt 0) { Stop-Capcheck $procId }
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
Write-Host "report written to evidence\report.json"
