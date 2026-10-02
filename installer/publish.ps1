# Creates or refreshes a GitHub release that always holds the latest tested build.
param([string]$Tag, [string]$File, [string]$Title, [string]$Notes, [switch]$Latest)
$ErrorActionPreference = 'Stop'
$Notes = ($Notes -split "`n" | ForEach-Object { $_ -replace '^\s{10}', '' }) -join "`n"
gh release view $Tag *> $null
if ($LASTEXITCODE -ne 0) {
  $extra = if ($Latest) { @('--latest') } else { @('--latest=false') }
  gh release create $Tag $File --title $Title --notes $Notes --target $env:GITHUB_SHA @extra
} else {
  gh release upload $Tag $File --clobber
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  gh release edit $Tag --title $Title --notes $Notes
}
exit $LASTEXITCODE
