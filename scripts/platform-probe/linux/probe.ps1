# NP-008: Linux probe in Docker. Builds the app once on Ubuntu 22.04 and runs
# it in each candidate distribution under Xvfb. Results and screenshots go to
# .test-data/platform-probe/linux. Run from the repository root after
# `npm run build`; Docker Desktop must be running.
param([string[]]$Distros = @("ubuntu:22.04", "ubuntu:24.04", "debian:12", "fedora:42"))
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$here = Join-Path $root "scripts/platform-probe/linux"
$out = Join-Path $root ".test-data/platform-probe/linux"
New-Item -ItemType Directory -Force $out | Out-Null
if (-not (Test-Path (Join-Path $root "dist/index.html"))) { throw "Run npm run build first." }

docker build -t koonapin-probe-build -f "$here/Dockerfile.build" $here
if ($LASTEXITCODE) { throw "build image failed" }
# Cargo caches and the target folder live in volumes between runs.
docker run --rm -v "${root}:/src:ro" -v "${out}/bin:/out" `
  -v koonapin-probe-target:/target -v koonapin-probe-registry:/opt/cargo/registry `
  koonapin-probe-build bash /src/scripts/platform-probe/linux/build.sh
if ($LASTEXITCODE) { throw "app build failed" }

foreach ($image in $Distros) {
  $name = $image -replace "[:.]", "-"
  Write-Host "== $image"
  docker run --rm -v "${out}/bin:/bin-in:ro" -v "${out}:/out" -v "${here}:/probe:ro" `
    $image bash /probe/run.sh $name
}
# Without the tray library, and under Wayland (Weston) instead of X11.
docker run --rm -e NO_TRAY_LIB=1 -v "${out}/bin:/bin-in:ro" -v "${out}:/out" -v "${here}:/probe:ro" `
  ubuntu:24.04 bash /probe/run.sh ubuntu-24-04-no-tray
docker run --rm -v "${out}/bin:/bin-in:ro" -v "${out}:/out" -v "${here}:/probe:ro" `
  ubuntu:24.04 bash /probe/run-wayland.sh ubuntu-24-04-wayland
