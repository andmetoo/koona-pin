# Publishes koona.app/pin to the owner's server with Caddy (NP-079): static files plus the site's
# Caddyfile fragment, which the server's main Caddyfile imports.
# Run by the owner, from the repository root:
#   pwsh scripts/deploy-site.ps1 -Server user@host
#   pwsh scripts/deploy-site.ps1 -DryRun     renders the Caddyfile and prints the remote steps; no build, no connection
# The server's paths are not in the repository: KOONAPIN_SITE_ROOT (the folder that holds site/ and
# the Caddyfile fragment) and KOONAPIN_CADDY_CONFIG (the main Caddyfile, for caddy validate) come
# from the environment or from .env in the repository root (.env.example); -Root and -CaddyConfig
# override them. KOONAPIN_FEEDBACK_URL comes the same way, read by the site build; a variable
# already set in the environment wins over .env.
# Needs ssh/scp access with sudo on the server. The previous version stays in site.old for a rollback.
# Without KOONAPIN_FEEDBACK_URL the build leaves the feedback form out (NP-088): the script refuses
# unless -WithoutFeedback says that is meant, so a later deploy cannot take /feedback down unnoticed.
param(
  [string] $Server,
  [string] $Root,
  [string] $CaddyConfig,
  [switch] $WithoutFeedback,
  [switch] $DryRun
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")

# KEY=VALUE lines of .env, as process.loadEnvFile of the build scripts reads them; the environment wins.
function Get-Setting([string] $Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value }
  $dotenv = Join-Path $repo ".env"
  if (-not (Test-Path $dotenv)) { return $null }
  foreach ($line in Get-Content $dotenv) {
    if ($line -match "^\s*$Name\s*=\s*(.*?)\s*$") { return $Matches[1].Trim('"', "'") }
  }
  return $null
}

# A server path goes unquoted into the remote shell script: only an absolute path of plain characters.
function Resolve-ServerPath([string] $Given, [string] $Name, [string] $What) {
  $value = if ($Given) { $Given } else { Get-Setting $Name }
  if (-not $value) { throw "$Name is not set: add it to .env (see .env.example) or pass it as a parameter. It is $What." }
  if ($value.StartsWith("/path/to/")) { throw "$Name is still the placeholder of .env.example ($value): set it to $What." }
  $value = $value.TrimEnd("/")
  if ($value -notmatch "^/[A-Za-z0-9._/-]+$") { throw "$Name must be an absolute path of letters, digits, '.', '_', '-' and '/': $value" }
  return $value
}

$Root = Resolve-ServerPath $Root "KOONAPIN_SITE_ROOT" "the folder on the server that holds site/ and the imported Caddyfile"
$CaddyConfig = Resolve-ServerPath $CaddyConfig "KOONAPIN_CADDY_CONFIG" "the server's main Caddyfile, the one that imports this site's"
if (-not $Server -and -not $DryRun) { throw "Pass -Server user@host, or -DryRun to see what would be done." }

# site/Caddyfile names the server's folder by a placeholder; the copy for the server has the real one.
function Get-RenderedCaddyfile([string] $SiteRoot) {
  $text = [IO.File]::ReadAllText((Join-Path $repo "site/Caddyfile")) -replace "`r", ""
  $text = $text.Replace('{$KOONAPIN_SITE_ROOT}', $SiteRoot)
  $left = [regex]::Matches($text, '\{\$KOONAPIN_[A-Z_]+\}') | ForEach-Object Value | Sort-Object -Unique
  if ($left) { throw "site/Caddyfile has placeholders this script does not fill: $($left -join ', ')" }
  return $text
}

$staging = Join-Path ([IO.Path]::GetTempPath()) "koona-pin-site-deploy"
New-Item -ItemType Directory -Force $staging | Out-Null
$caddyfile = Join-Path $staging "Caddyfile"
[IO.File]::WriteAllText($caddyfile, (Get-RenderedCaddyfile $Root), [Text.UTF8Encoding]::new($false))

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
"@ -replace "`r", ""

if ($DryRun) {
  Write-Host "Dry run: nothing is built, uploaded or run. The Caddyfile for the server: $caddyfile"
  Write-Host "Remote steps on $(if ($Server) { $Server } else { '<server>' }):"
  Write-Host $remote
  return
}

# The build reads .env itself (site/src/content.mjs); whether the form made it in is checked on
# the result, so the environment, .env and the build cannot disagree.
bun scripts/build-site.mjs
if ($LASTEXITCODE) { throw "build failed" }
# The site build's folder, as publish.site in scripts/lib/paths.mjs.
$site = Join-Path $repo "release\publish\site"
if (-not (Test-Path "$site/feedback/index.html") -and -not $WithoutFeedback) {
  throw "The build has no /feedback: KOONAPIN_FEEDBACK_URL is not set in .env or the environment (supabase/README.md). Set it or pass -WithoutFeedback."
}
if (-not (Test-Path "$site/shots")) { throw "release/publish/site/shots is missing: run bun scripts/site-screenshots.mjs first" }

$archive = Join-Path ([IO.Path]::GetTempPath()) "koona-pin-site.tgz"
tar -czf $archive -C $site .
scp $archive $caddyfile "${Server}:/tmp/"
if ($LASTEXITCODE) { throw "scp failed" }

ssh $Server $remote
if ($LASTEXITCODE) { throw "remote step failed" }
Remove-Item $archive
Remove-Item -Recurse $staging
Write-Host "Published. Check: https://koona.app/pin/, https://koona.app/pin/ru/, https://koona.app/pin/privacy, https://koona.app/pin/firefox/updates.json"
