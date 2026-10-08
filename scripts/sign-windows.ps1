# Signs one file with the Certum code signing certificate in SimplySign (Р-9, NP-042) and checks
# the result. Tauri calls it for every file it signs when the installer is built with
# `bun scripts/build-installer.mjs --sign`; the build first runs it with -Check.
#   SIGN_CERT_SHA1  thumbprint of the certificate (not a secret): with SimplySign Desktop signed in,
#                   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint
#   SIGNTOOL        path to signtool.exe, only if it is not on PATH or in the Windows SDK folder
# SimplySign Desktop must be signed in (code from SimplySign Mobile): only then is the certificate
# in the store, and the session lasts 2 hours.
param([string]$File, [switch]$Check)
$ErrorActionPreference = 'Stop'

if (-not $env:SIGN_CERT_SHA1) { throw 'SIGN_CERT_SHA1 is not set' }
$thumbprint = ($env:SIGN_CERT_SHA1 -replace '\s', '').ToUpperInvariant()

$signtool = $env:SIGNTOOL
if (-not $signtool) { $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source }
if (-not $signtool) {
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Parent.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $signtool -or -not (Test-Path $signtool)) { throw 'signtool.exe not found: install the Windows SDK Signing Tools or set SIGNTOOL' }

$certificate = Get-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
if (-not $certificate) { throw "certificate $thumbprint is not in the store: sign in to SimplySign Desktop" }
if ($certificate.NotAfter -lt (Get-Date)) { throw "certificate $thumbprint expired on $($certificate.NotAfter)" }
if ($Check) {
  Write-Host "signing with $($certificate.Subject), $signtool"
  exit 0
}

if (-not $File) { throw 'no file to sign' }
$File = (Resolve-Path $File).Path
# Tauri runs this script in Windows PowerShell 5.1, where a native stderr line under 'Stop'
# becomes a terminating error: signtool may log there and still sign, so the signature below
# decides, not its streams.
$ErrorActionPreference = 'Continue'
try {
  $output = & $signtool sign /sha1 $thumbprint /tr 'http://time.certum.pl' /td sha256 /fd sha256 $File 2>&1 | ForEach-Object { "$_" } | Out-String
} finally {
  $ErrorActionPreference = 'Stop'
}
Write-Host $output
$signature = Get-AuthenticodeSignature -FilePath $File
if ($signature.Status -ne 'Valid') { throw "signature of $File is $($signature.Status): $($signature.StatusMessage)" }
if ($signature.SignerCertificate.Thumbprint -ne $thumbprint) { throw "$File is signed by $($signature.SignerCertificate.Subject), not by $thumbprint" }
if (-not $signature.TimeStamperCertificate) { throw "signature of $File has no timestamp" }
Write-Host "signed: $File ($($signature.SignerCertificate.Subject))"
