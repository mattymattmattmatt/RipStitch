# Assembles everything the Windows installer ships into build\RipStitch:
#   python\   embeddable CPython with pip and yt-dlp[default]
#   bin\      FFmpeg (yt-dlp's builds) and Deno, which yt-dlp needs for YouTube
#   engine\   ripstitch_engine.py
# Then installer\ripstitch.iss turns that folder into RipStitch-Setup.exe.
param(
  [string]$PythonVersion = '3.12.10'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is painfully slow with the progress bar

$root = Split-Path $PSScriptRoot -Parent
$app  = Join-Path $root 'build\RipStitch'
$tmp  = Join-Path ([IO.Path]::GetTempPath()) ('rs-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Force "$app\bin", "$app\engine" | Out-Null

function Get-File($url, $out) {
  Write-Host "  get $url"
  for ($i = 1; $i -le 4; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; return }
    catch { if ($i -eq 4) { throw }; Start-Sleep -Seconds (2 * $i) }
  }
}

Write-Host '== Python'
Get-File "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" "$tmp\python.zip"
Expand-Archive "$tmp\python.zip" "$app\python"
# The embeddable build ignores site-packages until its ._pth file says otherwise.
$pth = Get-ChildItem "$app\python\python3*._pth" | Select-Object -First 1
$lines = Get-Content $pth | Where-Object { $_ -notmatch '^\s*#?\s*import site' }
Set-Content $pth -Encoding ascii -Value ($lines + 'Lib\site-packages' + 'import site')
Get-File 'https://bootstrap.pypa.io/get-pip.py' "$tmp\get-pip.py"
& "$app\python\python.exe" "$tmp\get-pip.py" --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE) { throw 'get-pip failed' }
& "$app\python\python.exe" -m pip install --no-warn-script-location --disable-pip-version-check 'yt-dlp[default]'
if ($LASTEXITCODE) { throw 'pip install yt-dlp failed' }
$ytdlp = & "$app\python\python.exe" -c 'import yt_dlp;print(yt_dlp.version.__version__)'
Write-Host "  yt-dlp $ytdlp"

Write-Host '== FFmpeg'
Get-File 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip' "$tmp\ffmpeg.zip"
Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg"
$ffbin = Get-ChildItem "$tmp\ffmpeg" -Recurse -Directory -Filter bin | Select-Object -First 1
Copy-Item "$($ffbin.FullName)\ffmpeg.exe", "$($ffbin.FullName)\ffprobe.exe", "$($ffbin.FullName)\*.dll" "$app\bin"

Write-Host '== Deno'
Get-File 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' "$tmp\deno.zip"
Expand-Archive "$tmp\deno.zip" "$app\bin"

Write-Host '== Engine'
Copy-Item "$root\docs\engine\ripstitch_engine.py" "$app\engine\"
Copy-Item "$PSScriptRoot\ripstitch.ico" "$app\"
$engineVersion = (Select-String -Path "$app\engine\ripstitch_engine.py" -Pattern '^VERSION = "(.+)"').Matches[0].Groups[1].Value
@{ kind = 'windows-app'; engine = $engineVersion; python = $PythonVersion; ytdlp = $ytdlp; built = (Get-Date -Format 'yyyy-MM-dd') } |
  ConvertTo-Json | Set-Content "$app\installed.json" -Encoding utf8

# Byte-compile ahead of time so the first launch is quick.
& "$app\python\python.exe" -m compileall -q "$app\python\Lib\site-packages" "$app\engine" | Out-Null

Remove-Item $tmp -Recurse -Force
$size = (Get-ChildItem $app -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ('== Done: {0:N0} MB in {1}' -f $size, $app)
if ($env:GITHUB_ENV) { "RS_VERSION=$engineVersion" | Out-File $env:GITHUB_ENV -Append -Encoding utf8 }
