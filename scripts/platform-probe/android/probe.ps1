# NP-008: Android probe in Docker — the probe APK for a phone and a check of
# the real app for Android. Results go to .test-data/platform-probe/android.
# Run from the repository root; Docker Desktop must be running. Building the
# image downloads the Android SDK and NDK (about 4 GB) and accepts their licences.
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$here = Join-Path $root "scripts/platform-probe/android"
$out = Join-Path $root ".test-data/platform-probe/android"
New-Item -ItemType Directory -Force $out | Out-Null
docker build -t koonapin-probe-android $here
if ($LASTEXITCODE) { throw "android image failed" }
docker run --rm -v "${root}:/src:ro" -v "${out}:/out" `
  -v koonapin-probe-android-target:/target -v koonapin-probe-android-registry:/opt/cargo/registry `
  -v koonapin-probe-gradle:/root/.gradle -v koonapin-probe-npm:/root/.npm `
  koonapin-probe-android bash /src/scripts/platform-probe/android/build.sh
