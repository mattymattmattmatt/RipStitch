# Creates or refreshes a GitHub release that always holds the latest tested build.
param([string]$Tag, [string[]]$Files, [string]$Title, [string]$Notes, [switch]$Latest)
$ErrorActionPreference = 'Stop'
$latestFlag = if ($Latest) { '--latest' } else { '--latest=false' }
$notesFile = Join-Path ([IO.Path]::GetTempPath()) "release-notes-$Tag.md"
(($Notes -split "`r?`n") | ForEach-Object { $_ -replace '^\s{10}', '' }) -join "`n" | Set-Content $notesFile -Encoding utf8
Write-Host "release $Tag <- $($Files -join ', ')"
gh release view $Tag *> $null
if ($LASTEXITCODE -ne 0) {
  gh release create $Tag @Files --title $Title --notes-file $notesFile --target $env:GITHUB_SHA $latestFlag
} else {
  gh release upload $Tag @Files --clobber
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  gh release edit $Tag --title $Title --notes-file $notesFile $latestFlag
}
exit $LASTEXITCODE
