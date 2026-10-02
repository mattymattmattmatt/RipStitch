# CI check for RipStitch-Setup.exe on a clean Windows machine:
# install silently -> start like Windows does at sign-in -> check bundled tools ->
# real downloads (merge, audio, section) -> stop -> uninstall.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root  = Split-Path $PSScriptRoot -Parent
$setup = Join-Path $root 'dist\RipStitch-Setup.exe'
$app   = Join-Path $env:LOCALAPPDATA 'Programs\RipStitch'
$api   = 'http://127.0.0.1:8731'
$log   = Join-Path $env:APPDATA 'RipStitch\engine.log'
$work  = Join-Path ([IO.Path]::GetTempPath()) 'rs-smoke'
New-Item -ItemType Directory -Force $work | Out-Null

function Fail($msg) {
  Write-Host "::error::$msg"
  if (Test-Path $log) { Write-Host '--- engine.log'; Get-Content $log -Tail 80 }
  exit 1
}
function Post($path, $body) { Invoke-RestMethod -Method Post -Uri "$api$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6) -TimeoutSec 300 }

Write-Host '== install'
$p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$work\install.log" -Wait -PassThru
if ($p.ExitCode) { Get-Content "$work\install.log" -Tail 40; Fail "installer exited with $($p.ExitCode)" }
foreach ($f in 'python\pythonw.exe', 'python\python.exe', 'bin\ffmpeg.exe', 'bin\ffprobe.exe', 'bin\deno.exe', 'engine\ripstitch_engine.py', 'installed.json') {
  if (-not (Test-Path (Join-Path $app $f))) { Fail "missing after install: $f" }
}
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'RipStitch Engine.lnk'
if (-not (Test-Path $startup)) { Fail 'no Startup shortcut' }

Write-Host '== start the way Windows does at sign-in'
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($startup)
Write-Host "  $($sh.TargetPath) $($sh.Arguments)"
Start-Process $sh.TargetPath -ArgumentList $sh.Arguments -WorkingDirectory $sh.WorkingDirectory
$h = $null
for ($i = 0; $i -lt 90 -and -not $h; $i++) { try { $h = Invoke-RestMethod "$api/api/health" -TimeoutSec 3 } catch { Start-Sleep 1 } }
if (-not $h) { Fail 'engine did not answer within 90 s' }
Write-Host "  engine $($h.version) | yt-dlp $($h.ytdlp) ($($h.runtime)) | ffmpeg $($h.ffmpeg_version) | js $($h.js_runtime) | $($h.install)"
if (-not $h.ytdlp) { Fail 'yt-dlp not found by the engine' }
if (-not $h.ffmpeg) { Fail 'FFmpeg not found by the engine' }
if ($h.js_runtime -ne 'deno') { Fail "expected Deno, got '$($h.js_runtime)'" }
if ($h.install -ne 'windows-app') { Fail "install kind is '$($h.install)'" }

Write-Host '== serve a test clip'
& (Join-Path $app 'bin\ffmpeg.exe') -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=1280x720:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$work\clip.mp4"
# Python's server for whole-file downloads; Node's http-server for the section clip (FFmpeg needs byte ranges).
Start-Process python -ArgumentList '-m', 'http.server', '9101', '--bind', '127.0.0.1', '--directory', $work -WindowStyle Hidden
Start-Process npx.cmd -ArgumentList '--yes', 'http-server', $work, '-p', '9100', '-a', '127.0.0.1', '-s' -WindowStyle Hidden
foreach ($u in 'http://127.0.0.1:9101/clip.mp4', 'http://127.0.0.1:9100/clip.mp4') {
  for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest $u -Method Head -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep 1 } }
}
$clip = 'http://127.0.0.1:9101/clip.mp4'
$rangeClip = 'http://127.0.0.1:9100/clip.mp4'

function Diagnose($url) {
  Write-Host '--- diagnostics'
  "  source clip: {0:N0} bytes" -f (Get-Item "$work\clip.mp4").Length
  Get-ChildItem "$env:USERPROFILE\Downloads\RipStitch" -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { "  {0,12:N0}  {1}" -f $_.Length, $_.Name }
  $f = Get-ChildItem "$env:USERPROFILE\Downloads\RipStitch" -Filter '*.mp4' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { '  first bytes: ' + ((Get-Content -LiteralPath $f.FullName -AsByteStream -TotalCount 24 | ForEach-Object { $_.ToString('x2') }) -join ' ') }
  try { (Invoke-WebRequest $url -Method Head).Headers.GetEnumerator() | ForEach-Object { "  header $($_.Key): $($_.Value)" } } catch { "  HEAD failed: $_" }
  Write-Host '--- yt-dlp -v on the same link'
  & (Join-Path $app 'python\python.exe') -m yt_dlp -v --no-colors --no-part -o "$work\diag.%(ext)s" $url 2>&1 | Select-Object -Last 25
  Get-ChildItem "$work\diag.*" -ErrorAction SilentlyContinue | ForEach-Object { "  diag download: {0:N0} bytes {1}" -f $_.Length, $_.Name }
}

Write-Host '== probe + downloads'
$r = (Post '/api/probe' @{ url = $clip }).result
Write-Host "  probe: $($r.title) via $($r.extractor), $($r.formats.Count) format(s)"
$ids = @()
$ids += (Post '/api/enqueue' @{ mode = 'quick'; quality = 'best'; label = 'best'; items = @(@{ url = $clip; title = 'best' }) }).ids
$ids += (Post '/api/enqueue' @{ mode = 'quick'; quality = 'audio'; label = 'audio'; items = @(@{ url = $clip; title = 'audio' }) }).ids
$ids += (Post '/api/enqueue' @{ mode = 'quick'; quality = 'best'; label = 'section'; section = @{ start = 2; end = 5 }; items = @(@{ url = $rangeClip; title = 'section' }) }).ids
$deadline = (Get-Date).AddMinutes(4)
do {
  Start-Sleep 2
  $jobs = (Invoke-RestMethod "$api/api/jobs").jobs | Where-Object { $ids -contains $_.id }
  $open = @($jobs | Where-Object { $_.status -in 'queued', 'running', 'merging' })
} while ($open.Count -and (Get-Date) -lt $deadline)
foreach ($j in $jobs) {
  Write-Host ("  {0,-8} {1,-9} {2,10:N0} bytes  {3}" -f $j.label, $j.status, $j.size, $j.filename)
  if ($j.status -ne 'done' -or -not $j.file_ok) {
    (Invoke-RestMethod "$api/api/log/$($j.id)").log | Select-Object -Last 25 | ForEach-Object { Write-Host "    $($_.level): $($_.msg)" }
    Diagnose ($(if ($j.label -eq 'section') { $rangeClip } else { $clip }))
    Fail "download '$($j.label)' ended as $($j.status): $($j.error)"
  }
}
$best = $jobs | Where-Object { $_.label -eq 'best' }
Invoke-WebRequest "$api/api/file?t=$($h.token)&job=$($best.id)" -OutFile "$work\back.mp4" -TimeoutSec 60
if ((Get-Item "$work\back.mp4").Length -ne $best.size) { Fail 'file endpoint returned the wrong size' }

Write-Host '== real-world YouTube check (informational)'
try {
  $yt = (Post '/api/probe' @{ url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }).result
  Write-Host "  YouTube OK: '$($yt.title)' with $($yt.formats.Count) formats"
} catch { Write-Host "::warning::YouTube probe failed from the CI runner (cloud IPs are often blocked): $($_.Exception.Message)" }

Write-Host '== stop via the Start-menu shortcut command'
& (Join-Path $app 'python\python.exe') (Join-Path $app 'engine\ripstitch_engine.py') --stop
if ($LASTEXITCODE) { Fail '--stop failed' }
Start-Sleep 2
try { Invoke-RestMethod "$api/api/ping" -TimeoutSec 3 | Out-Null; Fail 'engine still running after --stop' } catch { Write-Host '  stopped' }

Write-Host '== uninstall'
Start-Process (Join-Path $app 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait
for ($i = 0; $i -lt 30 -and (Test-Path "$app\python"); $i++) { Start-Sleep 1 }
if (Test-Path "$app\python") { Fail 'uninstall left the app folder behind' }
if (Test-Path $startup) { Fail 'uninstall left the Startup shortcut' }
Write-Host '== all good'
