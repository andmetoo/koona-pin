# Signs one file with the OV certificate in SSL.com eSigner (Р-9, NP-042) and checks the result.
# Tauri calls it for every file it signs when the installer is built with
# `node scripts/build-installer.mjs --sign`.
#   ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_TOTP_SECRET  from the owner's password manager
#   CODESIGNTOOL_DIR                                         the unpacked CodeSignTool folder
#   ESIGNER_CREDENTIAL_ID                                    only if the account has several certificates
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'

foreach ($name in 'ESIGNER_USERNAME', 'ESIGNER_PASSWORD', 'ESIGNER_TOTP_SECRET', 'CODESIGNTOOL_DIR') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set" }
}
$File = (Resolve-Path $File).Path
$arguments = @(
  'sign',
  "-username=$env:ESIGNER_USERNAME",
  "-password=$env:ESIGNER_PASSWORD",
  "-totp_secret=$env:ESIGNER_TOTP_SECRET",
  "-input_file_path=$File",
  '-override'
)
if ($env:ESIGNER_CREDENTIAL_ID) { $arguments += "-credential_id=$env:ESIGNER_CREDENTIAL_ID" }

# CodeSignTool reads its settings from its own folder. Tauri runs this script in Windows
# PowerShell 5.1, where a native stderr line under 'Stop' becomes a terminating error: the
# tool may log there and still sign, so the signature below decides, not its streams.
Push-Location $env:CODESIGNTOOL_DIR
$ErrorActionPreference = 'Continue'
try {
  $output = & .\CodeSignTool.bat @arguments 2>&1 | ForEach-Object { "$_" } | Out-String
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
}
Write-Host $output
# CodeSignTool can exit with 0 after an error, so the signature itself is checked.
$signature = Get-AuthenticodeSignature -FilePath $File
if ($signature.Status -ne 'Valid') { throw "signature of $File is $($signature.Status): $($signature.StatusMessage)" }
if (-not $signature.TimeStamperCertificate) { throw "signature of $File has no timestamp" }
Write-Host "signed: $File ($($signature.SignerCertificate.Subject))"
