# CI check for the standalone dist\RipStitch.exe on a clean Windows machine:
# first launch (unpack) -> app connects to its private engine -> screenshots of the window ->
# a real download through it -> read a link in the window -> close -> quick second launch.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root  = Split-Path $PSScriptRoot -Parent
$exe   = Join-Path $root 'dist\RipStitch.exe'
$out   = Join-Path $root 'dist\desktop-smoke'
$api   = 'http://127.0.0.1:8741'
$dlog  = Join-Path $env:LOCALAPPDATA 'RipStitch\Desktop\desktop.log'
$elog  = Join-Path $env:APPDATA 'RipStitch\Desktop\engine.log'
$work  = Join-Path ([IO.Path]::GetTempPath()) 'rs-desktop-smoke'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out, $work | Out-Null

function Fail($msg) {
  Write-Host "::error::$msg"
  foreach ($f in $dlog, $elog) { if (Test-Path $f) { Write-Host "--- $f"; Get-Content $f -Tail 60 } }
  Get-Process RipStitch, pythonw, python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  exit 1
}
function Launch($label) {
  Remove-Item "$out\smoke.txt", "$out\quit", "$out\read.txt", "$out\read-done.txt", "$out\picker.txt" -ErrorAction SilentlyContinue
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process $exe -ArgumentList '--smoke', "`"$out`"" -PassThru
  while (-not (Test-Path "$out\smoke.txt")) {
    if ($p.HasExited) { Fail "$label`: the app exited early (code $($p.ExitCode))" }
    if ($sw.Elapsed.TotalSeconds -gt 300) { Fail "$label`: no self-test result within 5 minutes" }
    Start-Sleep -Milliseconds 500
  }
  $state = (Get-Content "$out\smoke.txt" -Raw).Trim()
  Write-Host ("  {0}: ready in {1:N1} s -> {2}" -f $label, $sw.Elapsed.TotalSeconds, $state)
  return @{ Process = $p; State = $state }
}
function Close-App($p) {
  New-Item -ItemType File "$out\quit" -Force | Out-Null
  if (-not $p.WaitForExit(60000)) { Fail 'the app did not close' }
  Start-Sleep 2
  try { Invoke-RestMethod "$api/api/ping" -TimeoutSec 3 | Out-Null; Fail 'engine still running after the window closed' } catch { }
}

Write-Host '== test media'
$ff = Join-Path $root 'build\RipStitch\bin\ffmpeg.exe'
& $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=1280x720:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$work\Desktop Test Clip.mp4"
Start-Process python -ArgumentList '-m', 'http.server', '9102', '--bind', '127.0.0.1', '--directory', $work -WindowStyle Hidden
$clip = 'http://127.0.0.1:9102/Desktop%20Test%20Clip.mp4'
for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest $clip -Method Head -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep 1 } }

Write-Host '== first launch (unpacks the payload)'
$run = Launch 'first launch'
$s = $run.State.Split('|')   # state|version|install|ytdlp|ffmpeg|js|ua-marker
if ($s[0] -ne 'online') { Fail "the app never connected to its engine: $($run.State)" }
if ($s[2] -ne 'desktop') { Fail "engine install kind is '$($s[2])'" }
if (-not $s[3]) { Fail 'yt-dlp missing' }
if ($s[4] -ne 'true') { Fail 'FFmpeg missing' }
if ($s[5] -ne 'deno') { Fail "JS runtime is '$($s[5])'" }
if ([int]$s[6] -lt 0) { Fail 'desktop user-agent marker missing' }

Write-Host '== a real download through the app''s engine'
$body = @{ mode = 'quick'; quality = 'best'; label = 'best'; items = @(@{ url = $clip; title = 'desktop test' }) } | ConvertTo-Json -Depth 5
$id = (Invoke-RestMethod -Method Post -Uri "$api/api/enqueue" -ContentType 'application/json' -Body $body).ids[0]
$deadline = (Get-Date).AddMinutes(3)
do { Start-Sleep 2; $j = (Invoke-RestMethod "$api/api/jobs").jobs | Where-Object id -eq $id } while ($j.status -in 'queued', 'running', 'merging' -and (Get-Date) -lt $deadline)
Write-Host ("  {0} {1:N0} bytes {2}" -f $j.status, $j.size, $j.filename)
if ($j.status -ne 'done' -or -not $j.file_ok) {
  (Invoke-RestMethod "$api/api/log/$id").log | Select-Object -Last 25 | ForEach-Object { Write-Host "    $($_.level): $($_.msg)" }
  Fail "desktop download ended as $($j.status): $($j.error)"
}

Write-Host '== read a link inside the window'
Set-Content "$out\read.txt" $clip
for ($i = 0; $i -lt 240 -and -not (Test-Path "$out\read-done.txt"); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path "$out\read-done.txt")) { Fail 'the window never showed the read result' }

Write-Host '== Settings > Downloads > Browse (the Windows folder picker, accepted automatically)'
$picked = if (Test-Path "$out\picker.txt") { (Get-Content "$out\picker.txt" -Raw).Trim() } else { '' }
$expect = (Invoke-RestMethod "$api/api/health").out_dir
Write-Host "  picker returned '$picked' (download folder '$expect')"
if ($picked.TrimEnd('\') -ne $expect.TrimEnd('\')) { Fail 'the folder picker did not return the download folder' }

Write-Host '== close the window'
Close-App $run.Process

Write-Host '== second launch (already unpacked)'
$run2 = Launch 'second launch'
if (-not $run2.State.StartsWith('online|')) { Fail "second launch didn't connect: $($run2.State)" }
Close-App $run2.Process

Get-ChildItem $out -Filter *.png | ForEach-Object { "  screenshot {0} ({1:N0} KB)" -f $_.Name, ($_.Length / 1KB) }
Write-Host '== all good'
