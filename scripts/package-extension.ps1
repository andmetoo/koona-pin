$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'extension\chrome'
$outputDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = Join-Path $outputDirectory 'oddclicks-chrome.zip'
$stream = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    $runtimeFiles = Get-ChildItem -LiteralPath $sourcePath -Recurse -File | Where-Object { $_.Name -notlike '*.test.*' }
    foreach ($runtimeFile in $runtimeFiles) {
        $entryPath = $runtimeFile.FullName.Substring($sourcePath.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $runtimeFile.FullName, $entryPath) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
Write-Output $zipPath
