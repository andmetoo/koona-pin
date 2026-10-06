# Publishes pin.netami.app to the owner's server with Caddy (NP-079, Р-37, doc/site.md «Выкладка»).
# Run by the owner, from the repository root:
#   pwsh scripts/deploy-site.ps1 -Server user@host
# NETAMIPIN_FEEDBACK_URL comes from the environment or from .env in the repository root
# (.env.example); a variable already set in the environment wins.
# Needs ssh/scp access with sudo on the server. The previous version stays in site.old for a rollback.
# Without NETAMIPIN_FEEDBACK_URL the build leaves the feedback form out (NP-088): the script refuses
# unless -WithoutFeedback says that is meant, so a later deploy cannot take /feedback down unnoticed.
param(
  [Parameter(Mandatory)] [string] $Server,
  [string] $Root = "/path/to/site",
  [string] $CaddyConfig = "/path/to/Caddyfile",
  [switch] $WithoutFeedback
)
$ErrorActionPreference = "Stop"

# KEY=VALUE lines of .env, read like node's process.loadEnvFile in build-installer.mjs: comments,
# blank lines, an optional `export `, quotes around the value. Only names not set in the environment.
$dotenv = @{}
$dotenvFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $dotenvFile) {
  foreach ($line in Get-Content $dotenvFile -Encoding utf8) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name, $value = $Matches[1], $Matches[2]
      if ($value -match '^(["''])(.*)\1$') { $value = $Matches[2] } else { $value = $value -replace '\s+#.*$', '' }
      if (-not [Environment]::GetEnvironmentVariable($name)) { $dotenv[$name] = $value }
    }
  }
}

if (-not ($env:NETAMIPIN_FEEDBACK_URL -or $dotenv.NETAMIPIN_FEEDBACK_URL) -and -not $WithoutFeedback) {
  throw "NETAMIPIN_FEEDBACK_URL is not set: the site would lose /feedback. Set it in .env or the environment (supabase/README.md) or pass -WithoutFeedback."
}

# The build sees .env; the caller's session does not keep it afterwards (`./scripts/deploy-site.ps1`).
foreach ($name in $dotenv.Keys) { [Environment]::SetEnvironmentVariable($name, $dotenv[$name]) }
try {
  node scripts/build-site.mjs
} finally {
  foreach ($name in $dotenv.Keys) { [Environment]::SetEnvironmentVariable($name, $null) }
}
if ($LASTEXITCODE) { throw "build failed" }
if (-not (Test-Path dist-site/shots)) { throw "dist-site/shots is missing: run node scripts/site-screenshots.mjs first" }

$archive = Join-Path ([IO.Path]::GetTempPath()) "pin-netami-site.tgz"
tar -czf $archive -C dist-site .
scp $archive site/Caddyfile "${Server}:/tmp/"
if ($LASTEXITCODE) { throw "scp failed" }

# New files next to the old ones, then a swap: visitors never see a half-copied site.
$remote = @"
set -e
sudo mkdir -p $Root
sudo rm -rf $Root/site.new && sudo mkdir $Root/site.new
sudo tar -xzf /tmp/pin-netami-site.tgz -C $Root/site.new
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
rm -f /tmp/pin-netami-site.tgz /tmp/Caddyfile
"@
ssh $Server ($remote -replace "`r", "")
if ($LASTEXITCODE) { throw "remote step failed" }
Remove-Item $archive
Write-Host "Published. Check: https://pin.netami.app, https://pin.netami.app/ru/, https://pin.netami.app/privacy, https://pin.netami.app/firefox/updates.json"
