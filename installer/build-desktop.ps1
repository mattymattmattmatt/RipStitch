# Builds dist\RipStitch.exe: the standalone desktop app with everything embedded.
# Needs build\RipStitch (from build-windows.ps1) and the .NET SDK.
#   payload.zip = build\RipStitch (Python, yt-dlp, FFmpeg, Deno, engine) + site\ (the web app) + wv2\ (WebView2)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root   = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $root 'build\RipStitch'
$proj   = Join-Path $root 'desktop\RipStitchDesktop.csproj'
$stage  = Join-Path $root 'build\desktop-payload'
if (-not (Test-Path "$bundle\python\pythonw.exe")) { throw 'Run installer\build-windows.ps1 first.' }

Write-Host '== stage the payload'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Copy-Item $bundle $stage -Recurse
$site = New-Item -ItemType Directory (Join-Path $stage 'site')
Get-ChildItem (Join-Path $root 'docs') -Force | Where-Object Name -ne 'engine' | Copy-Item -Destination $site -Recurse
$meta = Get-Content "$stage\installed.json" -Raw | ConvertFrom-Json
$meta.kind = 'desktop'
$meta | ConvertTo-Json | Set-Content "$stage\installed.json" -Encoding utf8

Write-Host '== first compile (fetches WebView2)'
Remove-Item "$root\desktop\payload.zip", "$root\desktop\build.txt" -ErrorAction SilentlyContinue
dotnet build $proj -c Release -o "$root\build\desktop-pre" --nologo -v minimal
if ($LASTEXITCODE) { throw 'dotnet build failed' }
$wv2 = New-Item -ItemType Directory -Force (Join-Path $stage 'wv2')
Get-ChildItem "$root\build\desktop-pre" -Filter 'Microsoft.Web.WebView2.*.dll' |
  Where-Object Name -match 'Core|WinForms' | Copy-Item -Destination $wv2
$loader = Get-ChildItem "$root\build\desktop-pre" -Recurse -Filter 'WebView2Loader.dll' |
  Sort-Object { if ($_.FullName -match 'x64') { 0 } else { 1 } } | Select-Object -First 1
if (-not $loader) {
  $loader = Get-ChildItem "$env:USERPROFILE\.nuget\packages\microsoft.web.webview2" -Recurse -Filter 'WebView2Loader.dll' |
    Where-Object FullName -match 'win-x64' | Select-Object -First 1
}
if (-not $loader) { throw 'WebView2Loader.dll not found' }
Copy-Item $loader.FullName $wv2
Get-ChildItem $wv2 | ForEach-Object { Write-Host "  wv2\$($_.Name)" }

Write-Host '== pack and embed'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $root 'desktop\payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$sha = (git -C $root rev-parse --short HEAD).Trim()
"$($meta.engine)-$sha" | Set-Content (Join-Path $root 'desktop\build.txt') -NoNewline -Encoding ascii
dotnet build $proj -c Release -o "$root\build\desktop" --nologo -v minimal
if ($LASTEXITCODE) { throw 'dotnet build (with payload) failed' }
New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
Copy-Item "$root\build\desktop\RipStitch.exe" (Join-Path $root 'dist\RipStitch.exe') -Force
$f = Get-Item (Join-Path $root 'dist\RipStitch.exe')
Write-Host ('== dist\RipStitch.exe: {0:N1} MB (payload {1:N1} MB), build {2}-{3}' -f ($f.Length / 1MB), ((Get-Item $zip).Length / 1MB), $meta.engine, $sha)
