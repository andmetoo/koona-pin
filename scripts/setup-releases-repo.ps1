# Labels and settings of the public repository andmetoo/netami-pin-releases (releases and feedback, Р-9).
# Issue forms, README and SECURITY.md live in that repository itself. Run by the owner:
#
#   pwsh scripts/setup-releases-repo.ps1
param([string] $Repo = "andmetoo/netami-pin-releases")
$ErrorActionPreference = "Stop"

# Labels: type, status, browser. --force updates an existing label instead of failing.
$labels = @(
  @("bug", "d73a4a", "Something doesn't work"),
  @("idea", "a2eeef", "Suggestion for a new or better feature"),
  @("question", "d876e3", "How something works"),
  @("needs-info", "fbca04", "Waiting for details from the reporter"),
  @("confirmed", "2f6b4f", "Reproduced, tracked internally"),
  @("duplicate", "cfd3d7", "Already reported"),
  @("wontfix", "ffffff", "Not planned"),
  @("chrome", "4285f4", "Google Chrome"),
  @("edge", "0078d4", "Microsoft Edge"),
  @("firefox", "ff7139", "Mozilla Firefox")
)
foreach ($l in $labels) {
  gh label create $l[0] --repo $Repo --color $l[1] --description $l[2] --force | Out-Null
  Write-Host "label $($l[0])"
}
# GitHub's default labels that the forms don't use.
foreach ($name in "enhancement", "documentation", "good first issue", "help wanted", "invalid") {
  gh label delete $name --repo $Repo --yes 2>$null | Out-Null
}

gh repo edit $Repo --homepage https://pin.netami.app --enable-issues --enable-wiki=false --enable-projects=false --enable-discussions=false
gh api -X PUT "repos/$Repo/private-vulnerability-reporting" | Out-Null
Write-Host "private vulnerability reporting enabled"
