# Publishes koona.app/pin to the owner's server with Caddy (NP-079, Р-37, Р-47, doc/site.md «Выкладка»).
# Run by the owner, from the repository root:
#   pwsh scripts/deploy-site.ps1 -Server user@host
# KOONAPIN_FEEDBACK_URL comes from the environment or from .env in the repository root
# (.env.example), read by the site build; a variable already set in the environment wins.
# Needs ssh/scp access with sudo on the server. The previous version stays in site.old for a rollback.
# Without KOONAPIN_FEEDBACK_URL the build leaves the feedback form out (NP-088): the script refuses
# unless -WithoutFeedback says that is meant, so a later deploy cannot take /feedback down unnoticed.
param(
  [Parameter(Mandatory)] [string] $Server,
  [string] $Root = "/path/to/site",
  [string] $CaddyConfig = "/path/to/Caddyfile",
  [switch] $WithoutFeedback
)
$ErrorActionPreference = "Stop"

# The build reads .env itself (site/src/content.mjs); whether the form made it in is checked on
# the result, so the environment, .env and the build cannot disagree.
bun scripts/build-site.mjs
if ($LASTEXITCODE) { throw "build failed" }
# The site build's folder, as publish.site in scripts/lib/paths.mjs.
$site = Join-Path $PSScriptRoot "..\release\publish\site"
if (-not (Test-Path "$site/feedback/index.html") -and -not $WithoutFeedback) {
  throw "The build has no /feedback: KOONAPIN_FEEDBACK_URL is not set in .env or the environment (supabase/README.md). Set it or pass -WithoutFeedback."
}
if (-not (Test-Path "$site/shots")) { throw "release/publish/site/shots is missing: run bun scripts/site-screenshots.mjs first" }

$archive = Join-Path ([IO.Path]::GetTempPath()) "koona-pin-site.tgz"
tar -czf $archive -C $site .
scp $archive site/Caddyfile "${Server}:/tmp/"
if ($LASTEXITCODE) { throw "scp failed" }

# New files next to the old ones, then a swap: visitors never see a half-copied site.
$remote = @"
set -e
sudo mkdir -p $Root
sudo rm -rf $Root/site.new && sudo mkdir $Root/site.new
sudo tar -xzf /tmp/koona-pin-site.tgz -C $Root/site.new
sudo chmod -R a+rX $Root/site.new
# The backup goes to a folder of its own, out of reach of an import glob over the root.
sudo mkdir -p $Root/backup
if [ -f $Root/Caddyfile ]; then sudo cp $Root/Caddyfile $Root/backup/Caddyfile; fi
sudo install -m 644 /tmp/Caddyfile $Root/Caddyfile
# A broken config must not stay where the main Caddyfile imports it.
if ! sudo caddy validate --config $CaddyConfig --adapter caddyfile; then
  if [ -f $Root/backup/Caddyfile ]; then sudo cp $Root/backup/Caddyfile $Root/Caddyfile; else sudo rm -f $Root/Caddyfile; fi
  echo "caddy validate failed: the previous Caddyfile is back, the site is not changed" >&2
  exit 1
fi
sudo rm -rf $Root/site.old
if [ -d $Root/site ]; then sudo mv $Root/site $Root/site.old; fi
sudo mv $Root/site.new $Root/site
sudo systemctl reload caddy
rm -f /tmp/koona-pin-site.tgz /tmp/Caddyfile
"@
ssh $Server ($remote -replace "`r", "")
if ($LASTEXITCODE) { throw "remote step failed" }
Remove-Item $archive
Write-Host "Published. Check: https://koona.app/pin/, https://koona.app/pin/ru/, https://koona.app/pin/privacy, https://koona.app/pin/firefox/updates.json"
