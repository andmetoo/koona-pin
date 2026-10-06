# Feedback labels and settings of andmetoo/koona-pin, which holds the code, the releases and the
# public issues (Р-9, Р-47). Issue forms live in .github/ISSUE_TEMPLATE, the vulnerability policy in
# SECURITY.md. Run by the owner:
#
#   pwsh scripts/setup-repo.ps1
param([string] $Repo = "andmetoo/koona-pin")
$ErrorActionPreference = "Stop"

# Labels of the forms and of triage, next to the task labels of doc/roadmap.md.
# --force updates an existing label instead of failing; no label is deleted.
$labels = @(
  @("bug", "d73a4a", "Something doesn't work"),
  @("idea", "a2eeef", "Suggestion for a new or better feature"),
  @("question", "d876e3", "How something works"),
  @("needs-info", "fbca04", "Waiting for details from the reporter"),
  @("confirmed", "2f6b4f", "Reproduced"),
  @("chrome", "4285f4", "Google Chrome"),
  @("edge", "0078d4", "Microsoft Edge"),
  @("firefox", "ff7139", "Mozilla Firefox")
)
foreach ($l in $labels) {
  gh label create $l[0] --repo $Repo --color $l[1] --description $l[2] --force | Out-Null
  Write-Host "label $($l[0])"
}

gh repo edit $Repo --homepage https://koona.app/pin/ --enable-issues
gh api -X PUT "repos/$Repo/private-vulnerability-reporting" | Out-Null
Write-Host "private vulnerability reporting enabled"
